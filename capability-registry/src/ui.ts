import type { CapabilityRegistry } from "./registry";
import type { CapabilityDefinition } from "./types";

/**
 * Material for form generators (e.g. JSON Forms, custom HAI flows).
 * Does not bypass validation: callers should still run registry.validateInput before send.
 */
export function definitionsForFormShaping(registry: CapabilityRegistry): CapabilityDefinition[] {
  return registry.listCapabilities();
}

/** Single lookup for UI: schema + metadata without ZAKAI coupling */
export function getDefinitionForUi(
  registry: CapabilityRegistry,
  capability: string,
  version?: string
): CapabilityDefinition | undefined {
  return registry.getCapability(capability, version);
}
