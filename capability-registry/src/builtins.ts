import type { CapabilityDefinition, SemanticValidationResult } from "./types";

const HAI_ADAPTER = "hai-adapter";

/** Structured HAI / particle capabilities (validated only outside ZAKAI). */

export const haiParticleUpdateV1: CapabilityDefinition = {
  capability: "hai.particle.update",
  version: "1.0.0",
  adapter: { key: HAI_ADAPTER, route: "particle.update" },
  description: "Update HAI particle attributes (UI / adapter structured input)",
  tags: ["hai", "particle"],
  input_schema: {
    type: "object",
    required: ["particle_id", "attributes"],
    properties: {
      particle_id: { type: "string", minLength: 1 },
      attributes: { type: "object" },
      timestamp: { type: "string" },
    },
    additionalProperties: true,
  },
};

export const haiContextSnapshotV1: CapabilityDefinition = {
  capability: "hai.context.snapshot",
  version: "1.0.0",
  adapter: { key: HAI_ADAPTER, route: "context.snapshot" },
  description: "Snapshot context by scope (filters optional)",
  tags: ["hai", "context"],
  input_schema: {
    type: "object",
    required: ["scope"],
    properties: {
      scope: { type: "string", minLength: 1 },
      filters: { type: "object" },
    },
    additionalProperties: true,
  },
};

/** Example v2: stricter attributes (demonstrates version selection in registry tests). */
export const haiParticleUpdateV2: CapabilityDefinition = {
  capability: "hai.particle.update",
  version: "2.0.0",
  adapter: { key: HAI_ADAPTER, route: "particle.update" },
  description: "Particle update v2: attributes must include revision",
  tags: ["hai", "particle"],
  input_schema: {
    type: "object",
    required: ["particle_id", "attributes"],
    properties: {
      particle_id: { type: "string", minLength: 1 },
      attributes: {
        type: "object",
        required: ["revision"],
        properties: {
          revision: { type: "integer", minimum: 0 },
        },
        additionalProperties: true,
      },
      timestamp: { type: "string" },
    },
    additionalProperties: true,
  },
};

/** Semantic guard: revision must be a safe small integer (meaning layer; belt over JSON Schema drift). */
export function semanticParticleUpdateV2(input: unknown): SemanticValidationResult {
  if (input === null || typeof input !== "object") {
    return { valid: false, errors: ["input must be an object"] };
  }
  const o = input as Record<string, unknown>;
  const attr = o.attributes;
  if (attr === null || typeof attr !== "object") {
    return { valid: false, errors: ["attributes must be an object"] };
  }
  const rev = (attr as Record<string, unknown>).revision;
  if (typeof rev !== "number" || !Number.isInteger(rev)) {
    return { valid: false, errors: ["attributes.revision must be an integer"] };
  }
  if (rev < 0) {
    return { valid: false, errors: ["attributes.revision must be non-negative"] };
  }
  if (rev > 1_000_000) {
    return { valid: false, errors: ["attributes.revision out of allowed range"] };
  }
  return { valid: true };
}

/** Optional semantic for v1: if attributes.hue is a number, it must lie in [0, 1]. */
export function semanticParticleUpdateV1(input: unknown): SemanticValidationResult {
  if (input === null || typeof input !== "object") {
    return { valid: false, errors: ["input must be an object"] };
  }
  const attr = (input as Record<string, unknown>).attributes;
  if (attr !== undefined && attr !== null && typeof attr === "object") {
    const hue = (attr as Record<string, unknown>).hue;
    if (typeof hue === "number") {
      if (hue < 0 || hue > 1 || !Number.isFinite(hue)) {
        return { valid: false, errors: ["attributes.hue must be a finite number in [0, 1]"] };
      }
    }
  }
  return { valid: true };
}

export const defaultBuiltinDefinitions: CapabilityDefinition[] = [
  haiParticleUpdateV1,
  haiContextSnapshotV1,
  haiParticleUpdateV2,
];
