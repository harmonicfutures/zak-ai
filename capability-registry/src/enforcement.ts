import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  collectExecutionClassPolicyViolations,
  type CapabilityCompiledMeta,
} from "./capability-meta";
import type { GovernanceRuntime } from "./governance-runtime";
import { ajvErrorsToItems } from "./validate";
import type { ValidationErrorItem, ZakIdeBridgeRequestDraft } from "./types";

/** Host-asserted admission tier (set by trusted host after auth), not model-supplied. */
export type AdmissionAuthorityLevel = "none" | "standard" | "elevated" | "continuous_resonance";

export interface AuthorityContext {
  resolved_authority_level: AdmissionAuthorityLevel;
  source: string;
  evaluated_at: string;
  session_id?: string;
  subject_id?: string;
  /** Host-trusted slice of authority within a session (e.g. arc / task context); optional lineage dimension. */
  authority_context_id?: string;
}

const ADMISSION_RANK: Record<AdmissionAuthorityLevel, number> = {
  none: 0,
  standard: 1,
  elevated: 2,
  continuous_resonance: 3,
};

const REQUIREMENT_RANK: Record<CapabilityCompiledMeta["authority_requirements"], number> = {
  none: 0,
  standard: 1,
  elevated: 2,
  continuous_resonance_required: 3,
};

const ajvOut = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajvOut);
const outputValidators = new Map<string, ReturnType<typeof ajvOut.compile>>();

function policyKey(capability: string, version: string): string {
  return `${capability}@${version}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortKeysDeep(obj[k]);
  }
  return sorted;
}

export function stableInputKeyForReplay(input: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(input));
  } catch {
    return String(input);
  }
}

export function replayBlockedLookupKey(capability: string, version: string, input: unknown): string {
  return `${policyKey(capability, version)}:${stableInputKeyForReplay(input)}`;
}

export function validateAuthorityContext(authority: AuthorityContext | undefined): ValidationErrorItem[] {
  if (!authority) {
    return [
      {
        message:
          "authorityContext is required: host must provide resolved_authority_level, source, and evaluated_at",
      },
    ];
  }
  const errors: ValidationErrorItem[] = [];
  if (
    authority.resolved_authority_level !== "none" &&
    authority.resolved_authority_level !== "standard" &&
    authority.resolved_authority_level !== "elevated" &&
    authority.resolved_authority_level !== "continuous_resonance"
  ) {
    errors.push({
      message: "authorityContext.resolved_authority_level must be none|standard|elevated|continuous_resonance",
    });
  }
  if (typeof authority.source !== "string" || authority.source.trim().length === 0) {
    errors.push({ message: "authorityContext.source must be a non-empty string" });
  }
  if (typeof authority.evaluated_at !== "string" || authority.evaluated_at.trim().length === 0) {
    errors.push({ message: "authorityContext.evaluated_at must be a non-empty string" });
  }
  if (
    authority.authority_context_id !== undefined &&
    (typeof authority.authority_context_id !== "string" ||
      authority.authority_context_id.trim().length === 0)
  ) {
    errors.push({ message: "authorityContext.authority_context_id must be a non-empty string when set" });
  }
  return errors;
}

export function resolveAuthorityContext(
  resolved_authority_level: AdmissionAuthorityLevel,
  input?: Omit<AuthorityContext, "resolved_authority_level">
): AuthorityContext {
  return {
    resolved_authority_level,
    source: input?.source ?? "host",
    evaluated_at: input?.evaluated_at ?? new Date().toISOString(),
    ...(input?.session_id ? { session_id: input.session_id } : {}),
    ...(input?.subject_id ? { subject_id: input.subject_id } : {}),
    ...(input?.authority_context_id?.trim()
      ? { authority_context_id: input.authority_context_id.trim() }
      : {}),
  };
}

export function resolveExecutionAuthorityContext(
  draft: ZakIdeBridgeRequestDraft,
  runtime: GovernanceRuntime,
  seed?: AuthorityContext
): AuthorityContext {
  const ctx = draft.context ?? {};
  const session_id =
    typeof ctx.session_id === "string" && ctx.session_id.trim().length > 0
      ? ctx.session_id.trim()
      : seed?.session_id;
  const subject_id =
    typeof ctx.subject_id === "string" && ctx.subject_id.trim().length > 0
      ? ctx.subject_id.trim()
      : seed?.subject_id;
  const authority_context_id =
    typeof ctx.authority_context_id === "string" && ctx.authority_context_id.trim().length > 0
      ? ctx.authority_context_id.trim()
      : seed?.authority_context_id?.trim()
        ? seed.authority_context_id.trim()
        : undefined;
  return {
    resolved_authority_level: seed?.resolved_authority_level ?? "none",
    source: `resolved:${seed?.source ?? "host"}`,
    evaluated_at: runtime.now(),
    ...(session_id ? { session_id } : {}),
    ...(subject_id ? { subject_id } : {}),
    ...(authority_context_id ? { authority_context_id } : {}),
  };
}

export function idempotencyKeyFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = (input as Record<string, unknown>).idempotency_key;
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  return key.length > 0 ? key : undefined;
}

/**
 * For replay_behavior "blocked", reject a second prepared execution with the same normalized input
 * after a prior run completed output validation successfully.
 */
export function assertReplayAllowed(
  meta: CapabilityCompiledMeta,
  capability: string,
  version: string,
  input: unknown,
  runtime: GovernanceRuntime | undefined
): ValidationErrorItem | undefined {
  if (
    meta.execution_class !== "B" ||
    (meta.replay_behavior !== "blocked" && meta.replay_behavior !== "allowed_same_key")
  ) {
    return undefined;
  }
  if (!runtime) {
    return {
      message: `durable replay ledger required for ${capability}@${version} but governanceRuntime was not provided`,
    };
  }
  const idempotencyKey = idempotencyKeyFromInput(input);
  if (meta.idempotency === "keyed" && !idempotencyKey) {
    return {
      message: `idempotency_key required by meta.idempotency for ${capability}@${version}`,
    };
  }
  const k = replayBlockedLookupKey(capability, version, input);
  if (meta.replay_behavior === "allowed_same_key") {
    if (meta.idempotency !== "keyed") {
      return {
        message: `replay_behavior allowed_same_key requires idempotency keyed for ${capability}@${version}`,
      };
    }
    if (!idempotencyKey) {
      return {
        message: `allowed_same_key requires input.idempotency_key for ${capability}@${version}`,
      };
    }
    const existing = runtime.lookupIdempotencyKey(toIdempotencyIndexKey(capability, version, idempotencyKey));
    if (!existing.found) {
      return undefined;
    }
    if (existing.replay_key !== k) {
      return {
        message: `idempotency_key reuse with different input is blocked for ${capability}@${version}`,
      };
    }
    return undefined;
  }
  if (runtime.hasBlockedReplay(k)) {
    return {
      message: `replay blocked by meta.replay_behavior: duplicate execution for ${capability}@${version}`,
    };
  }
  return undefined;
}

function toIdempotencyIndexKey(capability: string, version: string, idempotencyKey: string): string {
  return `${capability}@${version}#${idempotencyKey}`;
}

export type ClassPolicyHook = (meta: CapabilityCompiledMeta) => ValidationErrorItem[];

/** Default: Class B/C structural policy from meta; authority rank enforced in checkAdmissionPolicy. */
export const defaultClassPolicyHook: ClassPolicyHook = (meta) =>
  collectExecutionClassPolicyViolations(meta);

export interface AdmissionPolicyOptions {
  /** Defaults to {@link defaultClassPolicyHook}. */
  classPolicy?: ClassPolicyHook;
}

/**
 * Fail closed on insufficient host authority or execution-class policy violations.
 */
export function checkAdmissionPolicy(
  meta: CapabilityCompiledMeta,
  authority: AuthorityContext,
  options?: AdmissionPolicyOptions
): ValidationErrorItem[] {
  const errors: ValidationErrorItem[] = [];
  const classPolicy = options?.classPolicy ?? defaultClassPolicyHook;
  errors.push(...classPolicy(meta));
  errors.push(...validateAuthorityContext(authority));
  if (errors.length > 0) {
    return errors;
  }

  const need = REQUIREMENT_RANK[meta.authority_requirements];
  const have = ADMISSION_RANK[authority.resolved_authority_level];
  if (have < need) {
    errors.push({
      message: `admission_authority insufficient: capability requires ${meta.authority_requirements}, host asserted ${authority.resolved_authority_level}`,
    });
  }
  return errors;
}

/**
 * Validate adapter output against compiled `output_schema`. No coercion; invalid → structured errors.
 */
export function validateAdapterOutput(
  capability: string,
  version: string,
  meta: CapabilityCompiledMeta,
  output: unknown
): { valid: true } | { valid: false; errors: ValidationErrorItem[] } {
  const key = policyKey(capability, version);
  let validate = outputValidators.get(key);
  if (!validate) {
    try {
      validate = ajvOut.compile(meta.output_schema);
    } catch (e) {
      return {
        valid: false,
        errors: [
          {
            message: `output_schema not compilable: ${(e as Error).message}`,
          },
        ],
      };
    }
    outputValidators.set(key, validate);
  }
  const ok = validate(output) as boolean;
  if (!ok) {
    return {
      valid: false,
      errors: ajvErrorsToItems(validate.errors ?? null),
    };
  }
  return { valid: true };
}
