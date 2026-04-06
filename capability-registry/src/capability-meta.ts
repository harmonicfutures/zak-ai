/**
 * Governance metadata from compiler `meta.json` (not part of capability_definition_hash).
 */

import type { ValidationErrorItem } from "./types";

export type AuthorityRequirement = "none" | "standard" | "elevated" | "continuous_resonance_required";

export type ExecutionClass = "A" | "B" | "C";

export const CLASS_B_SIDE_EFFECT_TIERS = ["low", "medium", "irreversible"] as const;
export type SideEffectTier = (typeof CLASS_B_SIDE_EFFECT_TIERS)[number];

export const CLASS_B_IDEMPOTENCY = ["none", "keyed", "inherent"] as const;
export type IdempotencyMode = (typeof CLASS_B_IDEMPOTENCY)[number];

export const CLASS_B_REPLAY_BEHAVIOR = ["blocked", "allowed_same_key", "allowed_read_only_subset"] as const;
export type ReplayBehavior = (typeof CLASS_B_REPLAY_BEHAVIOR)[number];

export interface CapabilityCompiledMeta {
  authority_requirements: AuthorityRequirement;
  execution_class: ExecutionClass;
  /** JSON Schema (draft-07) for adapter success payloads. */
  output_schema: Record<string, unknown>;
  /** Class C — required when execution_class is C */
  async_model?: string;
  job_id_field?: string;
  partial_receipt?: boolean;
  /** Class B — required when execution_class is B */
  side_effect_tier?: SideEffectTier;
  idempotency?: IdempotencyMode;
  replay_behavior?: ReplayBehavior;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isSideEffectTier(s: unknown): s is SideEffectTier {
  return typeof s === "string" && (CLASS_B_SIDE_EFFECT_TIERS as readonly string[]).includes(s);
}

function isIdempotency(s: unknown): s is IdempotencyMode {
  return typeof s === "string" && (CLASS_B_IDEMPOTENCY as readonly string[]).includes(s);
}

function isReplayBehavior(s: unknown): s is ReplayBehavior {
  return typeof s === "string" && (CLASS_B_REPLAY_BEHAVIOR as readonly string[]).includes(s);
}

/**
 * Structural + execution-class invariants for compiled meta (no authority rank checks).
 * Used at parse time and again at admission for in-memory registrations.
 */
export function collectExecutionClassPolicyViolations(meta: CapabilityCompiledMeta): ValidationErrorItem[] {
  const errors: ValidationErrorItem[] = [];
  const os = meta.output_schema;
  if (typeof os !== "object" || os === null || Array.isArray(os)) {
    errors.push({ message: "output_schema must be an object" });
  } else {
    const t = os.type;
    if (typeof t !== "string" || t.length === 0) {
      errors.push({
        message: "output_schema must include a non-empty string type (JSON Schema; required for output validation)",
      });
    }
  }

  if (meta.execution_class === "C") {
    if (typeof meta.async_model !== "string" || meta.async_model.length === 0) {
      errors.push({
        message: "execution_class C requires async_model in capability meta",
      });
    }
    if (typeof meta.job_id_field !== "string" || meta.job_id_field.length === 0) {
      errors.push({
        message: "execution_class C requires job_id_field in capability meta",
      });
    }
    if (typeof meta.partial_receipt !== "boolean") {
      errors.push({
        message: "execution_class C requires partial_receipt boolean in capability meta",
      });
    }
  }

  if (meta.execution_class === "B") {
    if (!isSideEffectTier(meta.side_effect_tier)) {
      errors.push({
        message: "execution_class B requires side_effect_tier: low|medium|irreversible",
      });
    }
    if (!isIdempotency(meta.idempotency)) {
      errors.push({
        message: "execution_class B requires idempotency: none|keyed|inherent",
      });
    }
    if (!isReplayBehavior(meta.replay_behavior)) {
      errors.push({
        message:
          "execution_class B requires replay_behavior: blocked|allowed_same_key|allowed_read_only_subset",
      });
    }
  }

  if (meta.execution_class === "A" || meta.execution_class === "C") {
    if (meta.side_effect_tier !== undefined) {
      errors.push({ message: "execution_class A/C must not set side_effect_tier" });
    }
    if (meta.idempotency !== undefined) {
      errors.push({ message: "execution_class A/C must not set idempotency" });
    }
    if (meta.replay_behavior !== undefined) {
      errors.push({ message: "execution_class A/C must not set replay_behavior" });
    }
  }

  return errors;
}

/**
 * Parse `meta.json` produced by `@zak/capability-compiler`.
 */
export function parseCapabilityCompiledMeta(json: unknown): CapabilityCompiledMeta {
  if (!isRecord(json)) {
    throw new Error("meta.json must be an object");
  }
  const ar = json.authority_requirements;
  if (
    ar !== "none" &&
    ar !== "standard" &&
    ar !== "elevated" &&
    ar !== "continuous_resonance_required"
  ) {
    throw new Error("meta.json: invalid authority_requirements");
  }
  const ec = json.execution_class;
  if (ec !== "A" && ec !== "B" && ec !== "C") {
    throw new Error("meta.json: execution_class must be A, B, or C");
  }
  const os = json.output_schema;
  if (!isRecord(os)) {
    throw new Error("meta.json: output_schema must be an object");
  }
  const meta: CapabilityCompiledMeta = {
    authority_requirements: ar,
    execution_class: ec,
    output_schema: os as Record<string, unknown>,
  };
  if (json.async_model !== undefined) meta.async_model = String(json.async_model);
  if (json.job_id_field !== undefined) meta.job_id_field = String(json.job_id_field);
  if (json.partial_receipt !== undefined) meta.partial_receipt = Boolean(json.partial_receipt);

  if (ec === "B") {
    const st = json.side_effect_tier;
    const id = json.idempotency;
    const rb = json.replay_behavior;
    if (!isSideEffectTier(st)) {
      throw new Error("meta.json: Class B requires side_effect_tier: low|medium|irreversible");
    }
    if (!isIdempotency(id)) {
      throw new Error("meta.json: Class B requires idempotency: none|keyed|inherent");
    }
    if (!isReplayBehavior(rb)) {
      throw new Error(
        "meta.json: Class B requires replay_behavior: blocked|allowed_same_key|allowed_read_only_subset"
      );
    }
    meta.side_effect_tier = st;
    meta.idempotency = id;
    meta.replay_behavior = rb;
  } else {
    if (json.side_effect_tier !== undefined) {
      throw new Error("meta.json: side_effect_tier is only valid for execution_class B");
    }
    if (json.idempotency !== undefined) {
      throw new Error("meta.json: idempotency is only valid for execution_class B");
    }
    if (json.replay_behavior !== undefined) {
      throw new Error("meta.json: replay_behavior is only valid for execution_class B");
    }
  }

  const viol = collectExecutionClassPolicyViolations(meta);
  if (viol.length > 0) {
    throw new Error(viol[0]!.message);
  }
  return meta;
}
