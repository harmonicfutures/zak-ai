import type { CapabilityDefinition } from "@zak/capability-registry";
import type { ValidatedWorksheet } from "./validate";

/** Registry record only — fields that participate in `computeCapabilityDefinitionHash`. */
export function worksheetToCapabilityDefinition(ws: ValidatedWorksheet): CapabilityDefinition {
  const def: CapabilityDefinition = {
    capability: ws.capability,
    version: ws.version,
    adapter: { key: ws.adapter.key, route: ws.adapter.route },
    input_schema: ws.input_schema,
  };
  if (ws.description !== undefined) {
    def.description = ws.description;
  }
  if (ws.tags !== undefined && ws.tags.length > 0) {
    def.tags = ws.tags;
  }
  return def;
}
