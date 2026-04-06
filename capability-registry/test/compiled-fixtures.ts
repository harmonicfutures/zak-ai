import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthorityContext } from "../src/enforcement";
import { parseDefinitionJson } from "../src/load-capabilities-from-disk";
import type { CapabilityDefinition } from "../src/types";
import type { CapabilityLogger } from "../src/load-capabilities-from-disk";

/** Repo root `capabilities/` (flat + versioned trees). */
export const REPO_CAPABILITIES_ROOT = join(__dirname, "..", "..", "capabilities");

export const silentLoadLogger: CapabilityLogger = {
  info: () => {},
  warn: () => {},
};

export function testAuthorityContext() {
  return resolveAuthorityContext("none", {
    source: "test",
    evaluated_at: "2026-04-06T12:00:00.000Z",
    session_id: "test-session",
    subject_id: "test-subject",
  });
}

export function definitionFromCompiledFlat(capabilityId: string): CapabilityDefinition {
  const p = join(REPO_CAPABILITIES_ROOT, capabilityId, "definition.json");
  return parseDefinitionJson(JSON.parse(readFileSync(p, "utf8")));
}

export function definitionFromCompiledVersioned(
  capabilityId: string,
  version: string
): CapabilityDefinition {
  const p = join(REPO_CAPABILITIES_ROOT, capabilityId, version, "definition.json");
  return parseDefinitionJson(JSON.parse(readFileSync(p, "utf8")));
}
