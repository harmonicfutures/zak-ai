import type { KernelRuntime, KernelResult, ExecutionEnvelope } from "../../contracts/kernel";
import type { ZakAuditEvent } from "../../contracts/audit";

/**
 * Signaling Packet Metadata for Ingress Sentry.
 * This structure captures the telemetry required to detect "Signaling Storms".
 */
export interface SignalingPacketMetadata {
  srcAddr: string;
  dstAddr: string;
  protocol: "SCTP" | "UDP" | "TCP";
  length: number;
  signalingType?: "INIT" | "HEARTBEAT" | "DATA";
  packetHash: string;
}

/**
 * Ingress Sentry Adapter (zak-ingress-sentry)
 * 
 * High-performance network filter adapter that bridges XDP packet filtering
 * with the Zero Asset Kernel's policy engine.
 */
export class SentryZakAdapter {
  constructor(
    private readonly kernel: KernelRuntime,
    private readonly adapterId = "zak-ingress-sentry-v1"
  ) {}

  /**
   * Ingest: Processes raw telemetry from the XDP hook.
   */
  public ingest(metadata: SignalingPacketMetadata, correlationId: string): ExecutionEnvelope<SignalingPacketMetadata> {
    this.logEvent("INGESTED", correlationId, { protocol: metadata.protocol });

    return {
      intentId: "mitigate-storm",
      payload: metadata
    };
  }

  /**
   * Execute: Evaluates the packet against kernel safety policies.
   */
  public async execute(envelope: ExecutionEnvelope<SignalingPacketMetadata>): Promise<KernelResult> {
    const startTime = Date.now();
    const result = await this.kernel.execute(envelope);

    this.logEvent("EXECUTED", "N/A", { 
        durationMs: Date.now() - startTime,
        outcome: result.outcome 
    });

    return result;
  }

  /**
   * Emit: Translates kernel decision into XDP action codes.
   */
  public emit(result: KernelResult): { action: "XDP_PASS" | "XDP_DROP" | "XDP_ABORTED" } {
    if (result.outcome === "success") {
      return { action: "XDP_PASS" };
    }

    if (result.outcome === "denied") {
        return { action: "XDP_DROP" };
    }

    return { action: "XDP_ABORTED" };
  }

  private logEvent(
    event: ZakAuditEvent["event"],
    correlationId: string,
    extras?: Partial<Omit<ZakAuditEvent, "event" | "correlationId" | "adapterId" | "timestamp">>
  ) {
    const logEntry: ZakAuditEvent = {
      timestamp: new Date().toISOString(),
      adapterId: this.adapterId,
      correlationId,
      event,
      ...extras
    };
    process.stdout.write(JSON.stringify(logEntry) + "\n");
  }
}

