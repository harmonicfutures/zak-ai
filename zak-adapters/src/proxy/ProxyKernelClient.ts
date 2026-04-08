import * as net from "net";
import type {
  ExecutionEnvelope,
  KernelResult,
  KernelRuntime,
} from "../contracts/kernel";
import { adapterBundleSha256 } from "./attestation";

type JsonObject = Record<string, unknown>;

/** Unified error when the engine proxy drops the TCP session (e.g. after policy kill). */
export const KERNEL_CONNECTION_LOST = "Kernel Connection Lost";

const KERNEL_BRIDGE = "execute.kernel_bridge";

/**
 * KernelRuntime that registers with attestation, then admit → execute through the
 * constitutional proxy. No bare invoke. Does not interpret policy — env carries
 * opaque claims from the engine.
 */
export class ProxyKernelClient implements KernelRuntime {
  poisoned = false;

  private socket: net.Socket | null = null;
  private inbound = "";
  private readonly pending: Array<{
    resolve: (v: JsonObject) => void;
    reject: (e: Error) => void;
  }> = [];
  private session: Promise<void> | null = null;
  private opTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fallback: KernelRuntime,
    private readonly routing: {
      readonly fromModule: string;
      readonly toModule: string;
    }
  ) {}

  static isProxyEnabled(): boolean {
    const p = process.env.ZAK_PROXY_PORT;
    return p !== undefined && p !== "" && !Number.isNaN(Number(p));
  }

  async request(frame: JsonObject): Promise<JsonObject> {
    if (!ProxyKernelClient.isProxyEnabled()) {
      throw new Error(
        "ProxyKernelClient.request() requires ZAK_PROXY_PORT to be set"
      );
    }
    if (this.poisoned) {
      throw new Error(KERNEL_CONNECTION_LOST);
    }
    await this.ensureSession();
    const sock = this.socket;
    if (!sock) {
      throw new Error("ProxyKernelClient: socket not initialized");
    }

    const line = JSON.stringify(frame) + "\n";
    const run = (): Promise<JsonObject> => {
      if (this.poisoned) {
        return Promise.reject(new Error(KERNEL_CONNECTION_LOST));
      }
      return new Promise<JsonObject>((resolve, reject) => {
        this.pending.push({ resolve, reject });
        sock.write(line, (err) => {
          if (err) {
            const p = this.pending.pop();
            const w = err instanceof Error ? err : new Error(String(err));
            if (p) p.reject(w);
            else reject(w);
          }
        });
      });
    };
    const op = this.opTail.then(run, run);
    this.opTail = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  }

  async execute<I, O>(
    envelope: ExecutionEnvelope<I, O>
  ): Promise<KernelResult<O>> {
    if (!ProxyKernelClient.isProxyEnabled()) {
      return this.fallback.execute(envelope);
    }
    if (this.poisoned) {
      throw new Error(KERNEL_CONNECTION_LOST);
    }

    const constitutionId = process.env.ZAK_CONSTITUTION_ID || "";
    const policyClaim = process.env.ZAK_POLICY_HASH_CLAIM || "";
    if (!constitutionId) {
      throw new Error(
        "ProxyKernelClient: ZAK_CONSTITUTION_ID required when proxy is enabled"
      );
    }

    let payload: unknown = envelopePayloadClone(envelope.payload);
    if (process.env.ZAK_ADVERSARIAL_MODE === "1") {
      payload = adversarialPayloadProbe(payload);
    }

    const intentId = envelope.intentId;
    const proposal = buildProposal(payload, intentId, this.routing);

    const admitFrame: JsonObject = {
      op: "admit",
      context: {
        constitution_id: constitutionId,
        correlation_id: intentId,
      },
      proposal,
    };
    if (policyClaim) {
      admitFrame.policy_hash_claim = policyClaim;
    }
    const admitRes = await this.request(admitFrame);

    if (admitRes.ok !== true || admitRes.admitted !== true) {
      return {
        outcome: "denied",
        error:
          typeof admitRes.error === "string" ? admitRes.error : "admit denied",
      };
    }

    const ticket = admitRes.admit_ticket;
    if (typeof ticket !== "string" || !ticket) {
      return { outcome: "denied", error: "admit missing admit_ticket" };
    }
    const admitReceiptId = admitRes.admit_receipt_id;
    if (typeof admitReceiptId !== "string" || !admitReceiptId) {
      return { outcome: "denied", error: "admit missing admit_receipt_id" };
    }

    const execEnvelope = {
      intentId: envelope.intentId,
      payload,
    };

    const execRes = await this.request({
      op: "execute",
      admit_ticket: ticket,
      admit_receipt_id: admitReceiptId,
      proposal,
      envelope: execEnvelope,
      context: { correlation_id: intentId },
    });

    return interpretGoldExecuteResponse<O>(execRes, {
      admittedCapability: proposal.capability,
      capabilityVersion:
        typeof proposal.capability_version === "string"
          ? proposal.capability_version
          : undefined,
      admitReceiptId,
    });
  }

  private attachSocketHandlers(sock: net.Socket): void {
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("error", (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.poisonFromTransportLoss(e);
    });
    sock.on("close", () => {
      this.poisonFromTransportLoss(new Error("Kernel TCP socket closed"));
    });
  }

  private poisonFromTransportLoss(source?: Error): void {
    if (this.poisoned) {
      return;
    }
    this.poisoned = true;
    const lost = new Error(KERNEL_CONNECTION_LOST);
    if (source) {
      (lost as Error & { cause?: Error }).cause = source;
    }
    this.rejectAllPendingAndResetTransport(lost);
  }

  private onData(chunk: Buffer): void {
    this.inbound += chunk.toString("utf8");
    for (;;) {
      const i = this.inbound.indexOf("\n");
      if (i < 0) break;
      const line = this.inbound.slice(0, i);
      this.inbound = this.inbound.slice(i + 1);
      const next = this.pending.shift();
      if (!next) break;
      try {
        next.resolve(JSON.parse(line) as JsonObject);
      } catch (e) {
        next.reject(
          e instanceof Error ? e : new Error("Invalid JSON from proxy")
        );
      }
    }
  }

  private rejectAllPendingAndResetTransport(err: Error): void {
    while (this.pending.length) {
      const p = this.pending.shift()!;
      p.reject(err);
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = null;
    this.session = null;
    this.inbound = "";
    this.opTail = Promise.resolve();
  }

  private async ensureSession(): Promise<void> {
    if (!ProxyKernelClient.isProxyEnabled()) {
      return;
    }
    if (this.poisoned) {
      throw new Error(KERNEL_CONNECTION_LOST);
    }
    if (!this.session) {
      this.session = this.openAndRegister().catch((e) => {
        this.session = null;
        if (!this.poisoned) {
          this.socket = null;
          this.inbound = "";
          const err = e instanceof Error ? e : new Error(String(e));
          while (this.pending.length) {
            this.pending.shift()!.reject(err);
          }
        }
        throw e;
      });
    }
    await this.session;
  }

  private async openAndRegister(): Promise<void> {
    if (this.poisoned) {
      throw new Error(KERNEL_CONNECTION_LOST);
    }
    const host = process.env.ZAK_PROXY_HOST || "127.0.0.1";
    const port = Number(process.env.ZAK_PROXY_PORT);
    const clientId = process.env.ZAK_PROXY_CLIENT_ID;
    const plugin = process.env.ZAK_PROXY_PLUGIN;
    const adapterId = process.env.ZAK_ADAPTER_ID || "";

    if (!Number.isFinite(port) || port <= 0) {
      throw new Error("ProxyKernelClient: ZAK_PROXY_PORT must be a positive integer");
    }
    if (!clientId) {
      throw new Error("ProxyKernelClient: ZAK_PROXY_CLIENT_ID is required when ZAK_PROXY_PORT is set");
    }
    if (!plugin) {
      throw new Error("ProxyKernelClient: ZAK_PROXY_PLUGIN is required when ZAK_PROXY_PORT is set");
    }
    if (!adapterId) {
      throw new Error("ProxyKernelClient: ZAK_ADAPTER_ID is required when ZAK_PROXY_PORT is set");
    }

    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => {
        this.socket = sock;
        this.attachSocketHandlers(sock);
        resolve();
      });
      sock.once("error", reject);
    });

    const caps = (process.env.ZAK_ADAPTER_CAPABILITIES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const declared = caps.length > 0 ? caps : [KERNEL_BRIDGE, "search_files", "list_files", "read_file", "commit_edit", "conversation.respond"];

    const regLine =
      JSON.stringify({
        op: "register",
        client_id: clientId,
        plugin,
        adapter_id: adapterId,
        declared_capabilities: declared,
        adapter_bundle_hash: adapterBundleSha256(),
      }) + "\n";

    const regResponse = await new Promise<JsonObject>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(regLine, (err) => {
        if (err) {
          this.pending.pop();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    if (regResponse.ok !== true) {
      const msg =
        typeof regResponse.error === "string"
          ? regResponse.error
          : "proxy register rejected";
      throw new Error(`ProxyKernelClient: register failed — ${msg}`);
    }
  }
}

function envelopePayloadClone<I>(payload: I): unknown {
  return JSON.parse(
    JSON.stringify(payload, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    )
  );
}

/** Tripwire substring for proxy adversarial_mode (proposal JSON must contain "malformed"). */
function adversarialPayloadProbe(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      malformed_probe: true,
    };
  }
  return { wrapped: payload, malformed_probe: true };
}

function buildProposal(
  payload: unknown,
  intentId: string,
  routing: {
    readonly fromModule: string;
    readonly toModule: string;
  }
): JsonObject & {
  capability: string;
  from_module: string;
  to_module: string;
  intent_id: string;
  payload: unknown;
  capability_version?: string;
  capability_definition_hash?: string;
} {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    const req =
      root.capability_request !== null
      && typeof root.capability_request === "object"
      && !Array.isArray(root.capability_request)
        ? (root.capability_request as Record<string, unknown>)
        : null;
    const capability =
      req && typeof req.capability === "string" && req.capability.trim().length > 0
        ? req.capability.trim()
        : KERNEL_BRIDGE;
    const proposal: JsonObject & {
      capability: string;
      from_module: string;
      to_module: string;
      intent_id: string;
      payload: unknown;
      capability_version?: string;
      capability_definition_hash?: string;
    } = {
      capability,
      from_module: routing.fromModule,
      to_module: routing.toModule,
      intent_id: intentId,
      payload,
    };
    if (req && typeof req.capability_version === "string" && req.capability_version.trim().length > 0) {
      proposal.capability_version = req.capability_version.trim();
    } else {
      proposal.capability_version = "1.0.0";
    }
    if (
      req
      && typeof req.capability_definition_hash === "string"
      && req.capability_definition_hash.trim().length > 0
    ) {
      proposal.capability_definition_hash = req.capability_definition_hash;
    }
    return proposal;
  }

  return {
    capability: KERNEL_BRIDGE,
    from_module: routing.fromModule,
    to_module: routing.toModule,
    intent_id: intentId,
    payload,
    capability_version: "1.0.0",
  };
}

function interpretGoldExecuteResponse<O>(
  res: JsonObject,
  runtime: {
    admittedCapability: string;
    capabilityVersion?: string;
    admitReceiptId: string;
  }
): KernelResult<O> {
  if (res.ok !== true || res.executed !== true) {
    const errMsg =
      typeof res.error === "string" ? res.error : "proxy execute error";
    return {
      outcome: "denied",
      runtime: {
        ...runtime,
        executeReceiptId:
          typeof res.execute_receipt_id === "string" ? res.execute_receipt_id : undefined,
      },
      error: errMsg,
    };
  }

  const gold = res.gold;
  if (gold && typeof gold === "object") {
    const g = gold as JsonObject;
    const outcome = g.outcome;
    if (outcome === "success") {
      return {
        outcome: "success",
        digest: g.digest as KernelResult<O>["digest"],
        runtime: {
          ...runtime,
          executeReceiptId:
            typeof res.execute_receipt_id === "string" ? res.execute_receipt_id : undefined,
        },
        output: g.output as O,
      };
    }
    if (outcome === "denied" || g.error) {
      return {
        outcome: "denied",
        runtime: {
          ...runtime,
          executeReceiptId:
            typeof res.execute_receipt_id === "string" ? res.execute_receipt_id : undefined,
        },
        error: String(g.error ?? "gold denied"),
      };
    }
  }

  return {
    outcome: "denied",
    runtime: {
      ...runtime,
      executeReceiptId:
        typeof res.execute_receipt_id === "string" ? res.execute_receipt_id : undefined,
    },
    error: "unexpected gold response",
  };
}
