import type { CapabilityRegistry } from "./registry";
import type { SemanticValidationResult } from "./types";

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
  const a = attr as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(a, "hue")) {
    const hue = a.hue;
    if (typeof hue !== "number") {
      return { valid: false, errors: ["attributes.hue must be a number"] };
    }
    if (!Number.isFinite(hue) || hue < 0 || hue > 1) {
      return { valid: false, errors: ["attributes.hue must be a finite number in [0, 1]"] };
    }
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

/**
 * Register host-side semantic validators for capabilities that are **not** expressible as JSON Schema alone.
 * Capability **definitions** must come from compiled `capabilities/` (single source of truth).
 */
export function registerBuiltinSemanticValidators(registry: CapabilityRegistry): void {
  registry.registerSemanticValidator("hai.particle.update", "1.0.0", semanticParticleUpdateV1);
  registry.registerSemanticValidator("hai.particle.update", "2.0.0", semanticParticleUpdateV2);
}
