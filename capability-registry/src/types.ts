/**
 * Host-side binding so registry and adapter routing stay in sync (ZAKAI ignores this; host must not).
 */
export interface CapabilityAdapterBinding {
  /** Stable adapter process / plugin key (e.g. npm workspace, binary name). */
  key: string;
  /** Route within the adapter (handler id, method name, queue topic, etc.). */
  route: string;
}

/**
 * Capability metadata and JSON Schema for input (enforced only outside ZAKAI).
 */
export interface CapabilityDefinition {
  capability: string;
  version: string;
  /** Where this capability is implemented in the adapter layer (host routing; not ZAKAI policy). */
  adapter: CapabilityAdapterBinding;
  /** JSON Schema (draft-07 compatible) for the opaque `input` object sent toward ZAKAI/adapters */
  input_schema: Record<string, unknown>;
  description?: string;
  tags?: string[];
}

export interface ValidationErrorItem {
  path?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationErrorItem[];
}

/** Meaning / domain checks beyond JSON Schema. Host-only; optional per capability version. */
export type SemanticValidator = (input: unknown) => SemanticValidationResult;

export interface SemanticValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * UI / editor phase: version may be omitted to mean “resolve at submit time” (see prepareExecutionRequest).
 */
export interface ZakIdeBridgeRequestDraft {
  capability: string;
  input: Record<string, unknown>;
  context: {
    constitution_id: string;
    [key: string]: unknown;
  };
  /**
   * If set, must match a registered version for this capability.
   * If omitted, latest registered version is resolved once at prepare time (pinned on the output).
   */
  capability_version?: string;
}

/**
 * Execution / bridge phase: always includes an explicit, registry-resolved version string.
 * Host should send this shape toward the membrane; ZAKAI remains opaque to version semantics until you wire proxy receipts.
 *
 * **Definition provenance (`capability_definition_hash`):**
 * - Compute **only** on the host at resolution time from the **actual** `CapabilityDefinition` used
 *   to validate (see `computeCapabilityDefinitionHash`). Carry **unchanged** on the wire — octet-stable,
 *   not a hint. The membrane records and may compare to release-pinned expectations; it never recomputes.
 */
export interface ZakIdeBridgeRequest {
  capability: string;
  input: Record<string, unknown>;
  context: {
    constitution_id: string;
    [key: string]: unknown;
  };
  /** Always set — canonical version from the matched CapabilityDefinition (never implicit “latest” on the wire). */
  capability_version: string;
  /**
   * Optional until you enforce it operationally. When set, must be exactly `sha256:` + 64 lowercase hex.
   * Host-computed only; membrane records and may pin-compare — never recomputes or normalizes.
   * Rollout: observability (optional hash → receipts), enforcement (always send + snapshot pins), mixed (pins per pair).
   */
  capability_definition_hash?: string;
}
