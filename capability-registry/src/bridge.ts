import { computeCapabilityDefinitionHash } from "./definition-hash";
import {
  assertReplayAllowed,
  checkAdmissionPolicy,
  resolveExecutionAuthorityContext,
  validateAdapterOutput,
  type AdmissionPolicyOptions,
  type AuthorityContext,
} from "./enforcement";
import type { GovernanceRuntime } from "./governance-runtime";
import type { CapabilityRegistry } from "./registry";
import type {
  CapabilityAdapterBinding,
  ValidationErrorItem,
  ZakIdeBridgeRequest,
  ZakIdeBridgeRequestDraft,
} from "./types";

/** Failure stages for prepare-only errors (before adapter runs). */
export type PrepareFailureStage = "definition" | "input_validation" | "governance_meta" | "admission";

export type PrepareExecutionResult =
  | {
      ok: true;
      request: ZakIdeBridgeRequest;
      /** Same as registry definition.adapter for this resolved version (single source for host routing). */
      adapter: CapabilityAdapterBinding;
    }
  | { ok: false; stage: PrepareFailureStage; errors: ValidationErrorItem[] };

export interface PrepareExecutionOptions extends AdmissionPolicyOptions {
  /**
   * Trusted host-resolved authority provenance for this principal/session.
   * Compared to `authority_requirements` in compiled meta (fail closed).
   * Must be set explicitly — no silent default.
   */
  authorityContext: AuthorityContext;
  /** Required for durable replay enforcement on capabilities that block replay. */
  governanceRuntime?: GovernanceRuntime;
}

/**
 * Resolve version once, validate (schema + semantic), enforce admission policy from compiled meta,
 * produce a wire-safe request with explicit capability_version.
 * Call this immediately before enqueue / IPC to the membrane — avoids implicit “latest” on the wire.
 *
 * Unified governance prelude: every execution path should use this (via {@link executeGovernedCapability} or equivalent).
 */
export function prepareExecutionRequest(
  registry: CapabilityRegistry,
  draft: ZakIdeBridgeRequestDraft,
  options: PrepareExecutionOptions
): PrepareExecutionResult {
  if (options.authorityContext === undefined) {
    return {
      ok: false,
      stage: "admission",
      errors: [
        {
          message:
            "authorityContext is required: host must explicitly resolve none|standard|elevated|continuous_resonance with provenance",
        },
      ],
    };
  }
  if (!options.governanceRuntime) {
    return {
      ok: false,
      stage: "admission",
      errors: [
        {
          message: "governanceRuntime is required: governed admission must have durable governance state",
        },
      ],
    };
  }
  const resolvedAuthority = resolveExecutionAuthorityContext(draft, options.governanceRuntime, options.authorityContext);

  const resolved = registry.resolveDefinitionForExecution(draft.capability, draft.capability_version);
  if (!resolved) {
    return {
      ok: false,
      stage: "definition",
      errors: [
        {
          message: `unknown capability or version: ${draft.capability}${
            draft.capability_version ? `@${draft.capability_version}` : ""
          }`,
        },
      ],
    };
  }
  const { definition, version } = resolved;
  const v = registry.validateInput(draft.capability, draft.input, version);
  if (!v.valid) {
    return {
      ok: false,
      stage: "input_validation",
      errors: v.errors ?? [{ message: "validation failed" }],
    };
  }
  const meta = registry.getCapabilityMeta(draft.capability, version);
  if (!meta) {
    return {
      ok: false,
      stage: "governance_meta",
      errors: [
        {
          message: `governance metadata missing for ${draft.capability}@${version} (expected meta.json from compiled capabilities)`,
        },
      ],
    };
  }
  const policyErrors = checkAdmissionPolicy(meta, resolvedAuthority, options);
  if (policyErrors.length > 0) {
    return { ok: false, stage: "admission", errors: policyErrors };
  }

  const replayErr = assertReplayAllowed(
    meta,
    draft.capability,
    version,
    draft.input,
    options.governanceRuntime
  );
  if (replayErr) {
    return { ok: false, stage: "admission", errors: [replayErr] };
  }

  const capability_definition_hash = computeCapabilityDefinitionHash(definition);
  return {
    ok: true,
    request: {
      capability: draft.capability,
      input: draft.input,
      context: draft.context,
      capability_version: version,
      capability_definition_hash,
    },
    adapter: definition.adapter,
  };
}

/**
 * After adapter execution: validate response body against compiled `output_schema` (fail closed, no coercion).
 * Prefer {@link executeGovernedCapability} so output validation is never omitted at call sites.
 */
export function validateAdapterOutputForCapability(
  registry: CapabilityRegistry,
  capability: string,
  version: string,
  output: unknown
): { valid: true } | { valid: false; errors: ValidationErrorItem[] } {
  const meta = registry.getCapabilityMeta(capability, version);
  if (!meta) {
    return {
      valid: false,
      errors: [
        {
          message: `governance metadata missing for ${capability}@${version}`,
        },
      ],
    };
  }
  return validateAdapterOutput(capability, version, meta, output);
}
