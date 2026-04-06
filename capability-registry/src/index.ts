export type {
  CapabilityAdapterBinding,
  CapabilityDefinition,
  SemanticValidationResult,
  SemanticValidator,
  ValidationErrorItem,
  ValidationResult,
  ZakIdeBridgeRequest,
  ZakIdeBridgeRequestDraft,
} from "./types";
export { CapabilityRegistry } from "./registry";
export { computeCapabilityDefinitionHash } from "./definition-hash";
export { prepareExecutionRequest, type PrepareExecutionResult } from "./bridge";
export {
  defaultBuiltinDefinitions,
  haiContextSnapshotV1,
  haiParticleUpdateV1,
  haiParticleUpdateV2,
  semanticParticleUpdateV1,
  semanticParticleUpdateV2,
} from "./builtins";
export { definitionsForFormShaping, getDefinitionForUi } from "./ui";
export { pickLatestVersion } from "./version-sort";

/**
 * Suggested (capability, version) rows for the membrane whitelist JSON only — not a full export
 * of definitions. The snapshot must not grow into a second registry (no schemas here).
 * Merge with ZAKAI core rows and regenerate the snapshot with every release that changes
 * admissible pairs; pin `ZAK_CAPABILITY_SNAPSHOT_SHA256`.
 *
 * Stronger provenance later: hash the full CapabilityDefinition (or canonical serialization) on
 * the host and attach `capability_definition_hash` to execution requests / receipts.
 */
export function suggestedMembraneSnapshotPairs(): { capability: string; version: string }[] {
  return defaultBuiltinDefinitions.map((d) => ({ capability: d.capability, version: d.version }));
}

import { CapabilityRegistry } from "./registry";
import {
  defaultBuiltinDefinitions,
  semanticParticleUpdateV1,
  semanticParticleUpdateV2,
} from "./builtins";

/**
 * Registry preloaded with HAI / particle builtins and optional semantic validators.
 * For execution, prefer `prepareExecutionRequest(registry, draft)` so version is pinned explicitly.
 */
export function createRegistryWithBuiltins(): CapabilityRegistry {
  const r = new CapabilityRegistry();
  for (const d of defaultBuiltinDefinitions) {
    r.registerCapability(d);
  }
  r.registerSemanticValidator("hai.particle.update", "1.0.0", semanticParticleUpdateV1);
  r.registerSemanticValidator("hai.particle.update", "2.0.0", semanticParticleUpdateV2);
  return r;
}
