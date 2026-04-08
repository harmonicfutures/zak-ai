import type { CapabilityDefinition } from "./types";
import { sha256Hex } from "./sha256";

/**
 * **Hash algorithm identity includes the numeric `v` inside the payload.**
 *
 * If you change any of: which fields are included, optional-field rules, key sorting, array
 * ordering, number formatting, or `stableStringify` / `JSON.stringify` semantics for scalars —
 * you **must** bump `v`. Never "quietly fix" canonicalization while keeping `v` unchanged, or
 * the same logical definition will produce a different digest and every pin + audit chain will
 * look corrupt. That will feel like a bug; it will be someone breaking the contract.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Hash the **exact** `CapabilityDefinition` used for validation / adapter binding at resolve time.
 * Only the host computes this; the membrane must never recompute (dual hash = ambiguity, not safety).
 *
 * Fields omitted from the canonical payload are not part of identity (e.g. if optional `description`
 * / `tags` are left out of the object passed here, they do not affect the digest).
 */
export function computeCapabilityDefinitionHash(definition: CapabilityDefinition): string {
  // Invariant: `v` is the identity of the hash algorithm.
  // Any change to canonicalization (fields included, ordering, serialization)
  // MUST increment `v`. Do not modify behavior under the same `v`.
  // Pins and audits rely on this being a stable contract, not an implementation detail.
  const payload: Record<string, unknown> = {
    v: 1,
    capability: definition.capability,
    version: definition.version,
    adapter: {
      key: definition.adapter.key,
      route: definition.adapter.route,
    },
    input_schema: definition.input_schema,
  };
  if (definition.description !== undefined) {
    payload.description = definition.description;
  }
  if (definition.tags !== undefined && definition.tags.length > 0) {
    payload.tags = [...definition.tags].sort();
  }
  const canon = stableStringify(payload);
  const h = sha256Hex(canon);
  return `sha256:${h}`;
}
