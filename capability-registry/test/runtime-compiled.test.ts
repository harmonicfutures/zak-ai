import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  prepareExecutionRequest,
  suggestedMembraneSnapshotPairs,
} from "../src/index";
import { REPO_CAPABILITIES_ROOT, silentLoadLogger, testAuthorityContext } from "./compiled-fixtures";

function makeRuntime() {
  const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-runtime-"));
  const runtime = createFileGovernanceRuntime({
    rootDir,
    environmentId: "test",
    runtimeId: "runtime-compiled",
    now: () => "2026-04-06T12:00:00.000Z",
  });
  return {
    runtime,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

describe("runtime with compiled capabilities only", () => {
  it("suggestedMembraneSnapshotPairs lists all compiled pairs", () => {
    const pairs = suggestedMembraneSnapshotPairs(REPO_CAPABILITIES_ROOT);
    expect(pairs.length).toBe(9);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { capability: "hai.time.get", version: "1.0.0" },
        { capability: "hai.context.snapshot", version: "1.0.0" },
        { capability: "hai.particle.update", version: "1.0.0" },
        { capability: "hai.particle.update", version: "2.0.0" },
        { capability: "hai.state.slice.build", version: "1.0.0" },
        { capability: "zak.plan.trace.read", version: "1.0.0" },
        { capability: "zak.plan.artifact.validate", version: "1.0.0" },
        { capability: "zak.dev.filesystem.tree", version: "1.0.0" },
        { capability: "zak.dev.filesystem.read", version: "1.0.0" },
      ])
    );
  });

  it("end-to-end: registry from disk validates and pins hai.time.get", () => {
    const { runtime, cleanup } = makeRuntime();
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const prep = prepareExecutionRequest(
      registry,
      {
        capability: "hai.time.get",
        input: { timezone: "UTC" },
        context: { constitution_id: "zak-runtime-e2e" },
        capability_version: "1.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(true);
      if (!prep.ok) throw new Error("expected ok");
      expect(prep.adapter).toEqual({ key: "hai-adapter", route: "time.get" });
      expect(prep.request.capability).toBe("hai.time.get");
      expect(prep.request.capability_version).toBe("1.0.0");
      expect(prep.request.capability_definition_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it("end-to-end: hai.particle.update v2 with hash pin", () => {
    const { runtime, cleanup } = makeRuntime();
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const prep = prepareExecutionRequest(
      registry,
      {
        capability: "hai.particle.update",
        input: { particle_id: "demo-1", attributes: { revision: 1, hue: 0.5 } },
        context: { constitution_id: "zak-runtime-e2e" },
        capability_version: "2.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(true);
      if (!prep.ok) throw new Error("expected ok");
      expect(prep.adapter).toEqual({ key: "hai-adapter", route: "particle.update" });
    } finally {
      cleanup();
    }
  });
});
