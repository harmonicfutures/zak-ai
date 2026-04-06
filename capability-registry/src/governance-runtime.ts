import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecutionClass } from "./capability-meta";
import type { AdmissionAuthorityLevel, AuthorityContext } from "./enforcement";
import { sha256TaggedCanonical } from "./canonical-json";
import type { ValidationErrorItem } from "./types";

export interface GovernanceInvariant {
  scope: "startup" | "execution";
  ok: boolean;
  target: "receipt_store" | "replay_ledger" | "receipt_chain" | "meta" | "output_schema";
  message: string;
}

export interface GovernanceRuntimeOptions {
  rootDir: string;
  environmentId: string;
  runtimeId: string;
  now?: () => string;
}

export interface ExecutionReceipt {
  capability: string;
  version: string | null;
  capability_definition_hash: string | null;
  authority_level_used: AdmissionAuthorityLevel;
  authority: AuthorityContext;
  execution_class: ExecutionClass | null;
  timestamp: string;
  stage: string;
  success: boolean;
  output_validation_passed?: boolean;
  errors?: ValidationErrorItem[];
  receipt_hash: string;
  prev_receipt_hash: string | null;
  environment_id: string;
  runtime_id: string;
  chain_key: string;
  replay_key?: string;
  idempotency_key?: string;
}

export interface ReceiptDraft {
  capability: string;
  version: string | null;
  capability_definition_hash: string | null;
  authority: AuthorityContext;
  execution_class: ExecutionClass | null;
  stage: string;
  success: boolean;
  output_validation_passed?: boolean;
  errors?: ValidationErrorItem[];
  replay_key?: string;
  idempotency_key?: string;
  timestamp?: string;
}

export interface ReplayLedgerEntry {
  replay_key: string;
  capability: string;
  version: string;
  normalized_input: string;
  recorded_at: string;
  receipt_hash: string;
  idempotency_key?: string;
}

export interface ReceiptChainVerification {
  ok: boolean;
  checked: number;
  chain_heads: number;
  errors: string[];
}

export interface ReceiptAnchor {
  chain_key: string;
  anchored_receipt_hash: string;
  prev_anchor_hash: string | null;
  anchored_at: string;
  anchor_hash: string;
}

export interface ReceiptAnchorVerification {
  ok: boolean;
  checked: number;
  errors: string[];
}

export interface ReplayLedgerVerification {
  ok: boolean;
  checked: number;
  errors: string[];
}

export interface IdempotencyLookupResult {
  found: boolean;
  replay_key?: string;
}

export interface GovernanceRuntime {
  readonly environmentId: string;
  readonly runtimeId: string;
  now(): string;
  startupInvariants(): GovernanceInvariant[];
  assertStartupInvariants(): void;
  hasBlockedReplay(key: string): boolean;
  lookupIdempotencyKey(key: string): IdempotencyLookupResult;
  listReplayEntries(limit?: number): ReplayLedgerEntry[];
  listRecentReceipts(limit?: number): ExecutionReceipt[];
  persistReceipt(draft: ReceiptDraft): ExecutionReceipt;
  verifyReceiptChain(): ReceiptChainVerification;
  verifyReceiptAnchors(): ReceiptAnchorVerification;
  verifyReplayLedgerConsistency(): ReplayLedgerVerification;
}

function parseJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return [];
  return raw
    .split("\n")
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter(({ line }) => Boolean(line))
    .map(({ line, idx }) => {
      try {
        return JSON.parse(line) as T;
      } catch (e) {
        throw new Error(`${path}: invalid JSON on line ${idx + 1}: ${(e as Error).message}`);
      }
    });
}

function toReplayEntry(receipt: ExecutionReceipt): ReplayLedgerEntry | null {
  if (!receipt.success || receipt.stage !== "executed" || typeof receipt.replay_key !== "string") {
    return null;
  }
  const [capVersion, normalizedInput] = receipt.replay_key.split(":", 2);
  const at = capVersion.lastIndexOf("@");
  if (at <= 0 || normalizedInput === undefined) return null;
  return {
    replay_key: receipt.replay_key,
    capability: capVersion.slice(0, at),
    version: capVersion.slice(at + 1),
    normalized_input: normalizedInput,
    recorded_at: receipt.timestamp,
    receipt_hash: receipt.receipt_hash,
    ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
  };
}

function toIdempotencyIndexKey(capability: string, version: string, idempotencyKey: string): string {
  return `${capability}@${version}#${idempotencyKey}`;
}

function chainKeyFor(runtime: GovernanceRuntimeOptions, authority: AuthorityContext): string {
  return [
    `env:${runtime.environmentId}`,
    `runtime:${runtime.runtimeId}`,
    `session:${authority.session_id ?? "-"}`,
    `subject:${authority.subject_id ?? "-"}`,
  ].join("|");
}

function receiptHashPayload(receipt: Omit<ExecutionReceipt, "receipt_hash">): Record<string, unknown> {
  return {
    capability: receipt.capability,
    version: receipt.version,
    capability_definition_hash: receipt.capability_definition_hash,
    authority_level_used: receipt.authority_level_used,
    authority: receipt.authority,
    execution_class: receipt.execution_class,
    timestamp: receipt.timestamp,
    stage: receipt.stage,
    success: receipt.success,
    output_validation_passed: receipt.output_validation_passed ?? null,
    errors: receipt.errors ?? null,
    prev_receipt_hash: receipt.prev_receipt_hash,
    environment_id: receipt.environment_id,
    runtime_id: receipt.runtime_id,
    chain_key: receipt.chain_key,
    replay_key: receipt.replay_key ?? null,
    idempotency_key: receipt.idempotency_key ?? null,
  };
}

function anchorPayload(anchor: Omit<ReceiptAnchor, "anchor_hash">): Record<string, unknown> {
  return {
    chain_key: anchor.chain_key,
    anchored_receipt_hash: anchor.anchored_receipt_hash,
    prev_anchor_hash: anchor.prev_anchor_hash,
    anchored_at: anchor.anchored_at,
  };
}

class FileGovernanceRuntime implements GovernanceRuntime {
  readonly environmentId: string;
  readonly runtimeId: string;
  private readonly rootDir: string;
  private readonly receiptsPath: string;
  private readonly anchorsPath: string;
  private readonly receiptHeads = new Map<string, string>();
  private readonly blockedReplay = new Map<string, ReplayLedgerEntry>();
  private readonly idempotencyIndex = new Map<string, ReplayLedgerEntry>();
  private readonly receipts: ExecutionReceipt[] = [];
  private readonly anchors: ReceiptAnchor[] = [];
  private readonly clock: () => string;

  constructor(private readonly options: GovernanceRuntimeOptions) {
    this.environmentId = options.environmentId;
    this.runtimeId = options.runtimeId;
    this.rootDir = options.rootDir;
    this.receiptsPath = join(this.rootDir, "receipts.jsonl");
    this.anchorsPath = join(this.rootDir, "anchors.jsonl");
    this.clock = options.now ?? (() => new Date().toISOString());
    this.ensureFilesystem();
    this.loadState();
  }

  now(): string {
    return this.clock();
  }

  startupInvariants(): GovernanceInvariant[] {
    const invariants: GovernanceInvariant[] = [];
    try {
      const stats = statSync(this.rootDir);
      invariants.push({
        scope: "startup",
        ok: stats.isDirectory(),
        target: "receipt_store",
        message: stats.isDirectory() ? "receipt store root is available" : "receipt store root is not a directory",
      });
    } catch (e) {
      invariants.push({
        scope: "startup",
        ok: false,
        target: "receipt_store",
        message: `receipt store unavailable: ${(e as Error).message}`,
      });
    }
    invariants.push({
      scope: "startup",
      ok: existsSync(this.receiptsPath),
      target: "receipt_store",
      message: existsSync(this.receiptsPath) ? "receipt journal is available" : "receipt journal missing",
    });
    invariants.push({
      scope: "startup",
      ok: true,
      target: "replay_ledger",
      message: "replay ledger projection loaded from durable receipts",
    });
    const chain = this.verifyReceiptChain();
    invariants.push({
      scope: "startup",
      ok: chain.ok,
      target: "receipt_chain",
      message: chain.ok
        ? `receipt chain verified (${chain.checked} receipts across ${chain.chain_heads} chain heads)`
        : `receipt chain invalid: ${chain.errors[0]}`,
    });
    const anchors = this.verifyReceiptAnchors();
    invariants.push({
      scope: "startup",
      ok: anchors.ok,
      target: "receipt_chain",
      message: anchors.ok
        ? `receipt anchors verified (${anchors.checked} anchors)`
        : `receipt anchors invalid: ${anchors.errors[0]}`,
    });
    const replay = this.verifyReplayLedgerConsistency();
    invariants.push({
      scope: "startup",
      ok: replay.ok,
      target: "replay_ledger",
      message: replay.ok
        ? `replay ledger consistent (${replay.checked} entries)`
        : `replay ledger inconsistent: ${replay.errors[0]}`,
    });
    return invariants;
  }

  assertStartupInvariants(): void {
    const failing = this.startupInvariants().find((inv) => !inv.ok);
    if (failing) {
      throw new Error(`governance startup invariant failed (${failing.target}): ${failing.message}`);
    }
  }

  hasBlockedReplay(key: string): boolean {
    return this.blockedReplay.has(key);
  }

  lookupIdempotencyKey(key: string): IdempotencyLookupResult {
    const found = this.idempotencyIndex.get(key);
    if (!found) return { found: false };
    return { found: true, replay_key: found.replay_key };
  }

  listReplayEntries(limit = 50): ReplayLedgerEntry[] {
    return [...this.blockedReplay.values()]
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, limit);
  }

  listRecentReceipts(limit = 50): ExecutionReceipt[] {
    return this.receipts.slice(-limit).reverse();
  }

  persistReceipt(draft: ReceiptDraft): ExecutionReceipt {
    const timestamp = draft.timestamp ?? this.now();
    const chain_key = chainKeyFor(this.options, draft.authority);
    const prev_receipt_hash = this.receiptHeads.get(chain_key) ?? null;
    const receiptBase: Omit<ExecutionReceipt, "receipt_hash"> = {
      capability: draft.capability,
      version: draft.version,
      capability_definition_hash: draft.capability_definition_hash,
      authority_level_used: draft.authority.resolved_authority_level,
      authority: draft.authority,
      execution_class: draft.execution_class,
      timestamp,
      stage: draft.stage,
      success: draft.success,
      ...(draft.output_validation_passed !== undefined
        ? { output_validation_passed: draft.output_validation_passed }
        : {}),
      ...(draft.errors && draft.errors.length > 0 ? { errors: draft.errors } : {}),
      prev_receipt_hash,
      environment_id: this.environmentId,
      runtime_id: this.runtimeId,
      chain_key,
      ...(draft.replay_key ? { replay_key: draft.replay_key } : {}),
      ...(draft.idempotency_key ? { idempotency_key: draft.idempotency_key } : {}),
    };
    const receipt_hash = sha256TaggedCanonical(receiptHashPayload(receiptBase));
    const receipt: ExecutionReceipt = {
      ...receiptBase,
      receipt_hash,
    };
    appendFileSync(this.receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
    this.receipts.push(receipt);
    this.receiptHeads.set(chain_key, receipt_hash);
    const replay = toReplayEntry(receipt);
    if (replay) {
      this.blockedReplay.set(replay.replay_key, replay);
      if (replay.idempotency_key) {
        this.idempotencyIndex.set(
          toIdempotencyIndexKey(replay.capability, replay.version, replay.idempotency_key),
          replay
        );
      }
    }
    this.persistAnchor(receipt);
    return receipt;
  }

  verifyReceiptChain(): ReceiptChainVerification {
    const byChain = new Map<string, ExecutionReceipt[]>();
    for (const receipt of this.receipts) {
      const arr = byChain.get(receipt.chain_key);
      if (arr) arr.push(receipt);
      else byChain.set(receipt.chain_key, [receipt]);
    }

    const errors: string[] = [];
    let checked = 0;
    for (const [chainKey, entries] of byChain.entries()) {
      let prev: string | null = null;
      for (const entry of entries) {
        checked += 1;
        if (entry.prev_receipt_hash !== prev) {
          errors.push(
            `${chainKey}: prev_receipt_hash mismatch at ${entry.receipt_hash} (expected ${prev}, got ${entry.prev_receipt_hash})`
          );
        }
        const expected = sha256TaggedCanonical(receiptHashPayload({
          capability: entry.capability,
          version: entry.version,
          capability_definition_hash: entry.capability_definition_hash,
          authority_level_used: entry.authority_level_used,
          authority: entry.authority,
          execution_class: entry.execution_class,
          timestamp: entry.timestamp,
          stage: entry.stage,
          success: entry.success,
          ...(entry.output_validation_passed !== undefined
            ? { output_validation_passed: entry.output_validation_passed }
            : {}),
          ...(entry.errors ? { errors: entry.errors } : {}),
          prev_receipt_hash: entry.prev_receipt_hash,
          environment_id: entry.environment_id,
          runtime_id: entry.runtime_id,
          chain_key: entry.chain_key,
          ...(entry.replay_key ? { replay_key: entry.replay_key } : {}),
          ...(entry.idempotency_key ? { idempotency_key: entry.idempotency_key } : {}),
        }));
        if (expected !== entry.receipt_hash) {
          errors.push(
            `${chainKey}: receipt hash mismatch at ${entry.receipt_hash} (expected ${expected})`
          );
        }
        prev = entry.receipt_hash;
      }
    }
    return {
      ok: errors.length === 0,
      checked,
      chain_heads: byChain.size,
      errors,
    };
  }

  verifyReceiptAnchors(): ReceiptAnchorVerification {
    const errors: string[] = [];
    let checked = 0;
    let prev: string | null = null;
    const receiptHashes = new Set(this.receipts.map((r) => r.receipt_hash));
    for (const anchor of this.anchors) {
      checked += 1;
      if (!receiptHashes.has(anchor.anchored_receipt_hash)) {
        errors.push(`anchor ${anchor.anchor_hash} references missing receipt ${anchor.anchored_receipt_hash}`);
      }
      if (anchor.prev_anchor_hash !== prev) {
        errors.push(`anchor ${anchor.anchor_hash} prev mismatch (expected ${prev}, got ${anchor.prev_anchor_hash})`);
      }
      const expected = sha256TaggedCanonical(anchorPayload({
        chain_key: anchor.chain_key,
        anchored_receipt_hash: anchor.anchored_receipt_hash,
        prev_anchor_hash: anchor.prev_anchor_hash,
        anchored_at: anchor.anchored_at,
      }));
      if (expected !== anchor.anchor_hash) {
        errors.push(`anchor hash mismatch at ${anchor.anchor_hash} (expected ${expected})`);
      }
      prev = anchor.anchor_hash;
    }
    return { ok: errors.length === 0, checked, errors };
  }

  verifyReplayLedgerConsistency(): ReplayLedgerVerification {
    const errors: string[] = [];
    let checked = 0;
    const recomputed = new Map<string, ReplayLedgerEntry>();
    const recomputedIdem = new Map<string, ReplayLedgerEntry>();
    for (const receipt of this.receipts) {
      const replay = toReplayEntry(receipt);
      if (!replay) continue;
      recomputed.set(replay.replay_key, replay);
      if (replay.idempotency_key) {
        recomputedIdem.set(
          toIdempotencyIndexKey(replay.capability, replay.version, replay.idempotency_key),
          replay
        );
      }
    }
    for (const [key, value] of this.blockedReplay.entries()) {
      checked += 1;
      const expected = recomputed.get(key);
      if (!expected || expected.receipt_hash !== value.receipt_hash) {
        errors.push(`blocked replay entry mismatch for ${key}`);
      }
    }
    for (const [key, value] of this.idempotencyIndex.entries()) {
      checked += 1;
      const expected = recomputedIdem.get(key);
      if (!expected || expected.receipt_hash !== value.receipt_hash) {
        errors.push(`idempotency index mismatch for ${key}`);
      }
    }
    return { ok: errors.length === 0, checked, errors };
  }

  private ensureFilesystem(): void {
    mkdirSync(this.rootDir, { recursive: true });
    if (!existsSync(this.receiptsPath)) {
      writeFileSync(this.receiptsPath, "", "utf8");
    }
    if (!existsSync(this.anchorsPath)) {
      writeFileSync(this.anchorsPath, "", "utf8");
    }
  }

  private loadState(): void {
    const receipts = parseJsonLines<ExecutionReceipt>(this.receiptsPath);
    const anchors = parseJsonLines<ReceiptAnchor>(this.anchorsPath);
    this.receipts.push(...receipts);
    this.anchors.push(...anchors);
    for (const receipt of receipts) {
      this.receiptHeads.set(receipt.chain_key, receipt.receipt_hash);
      const replay = toReplayEntry(receipt);
      if (replay) {
        this.blockedReplay.set(replay.replay_key, replay);
        if (replay.idempotency_key) {
          this.idempotencyIndex.set(
            toIdempotencyIndexKey(replay.capability, replay.version, replay.idempotency_key),
            replay
          );
        }
      }
    }
  }

  private persistAnchor(receipt: ExecutionReceipt): void {
    const prev_anchor_hash = this.anchors.length > 0 ? this.anchors[this.anchors.length - 1]!.anchor_hash : null;
    const anchorBase: Omit<ReceiptAnchor, "anchor_hash"> = {
      chain_key: receipt.chain_key,
      anchored_receipt_hash: receipt.receipt_hash,
      prev_anchor_hash,
      anchored_at: receipt.timestamp,
    };
    const anchor_hash = sha256TaggedCanonical(anchorPayload(anchorBase));
    const anchor: ReceiptAnchor = { ...anchorBase, anchor_hash };
    appendFileSync(this.anchorsPath, `${JSON.stringify(anchor)}\n`, "utf8");
    this.anchors.push(anchor);
  }
}

export function createFileGovernanceRuntime(options: GovernanceRuntimeOptions): GovernanceRuntime {
  return new FileGovernanceRuntime(options);
}
