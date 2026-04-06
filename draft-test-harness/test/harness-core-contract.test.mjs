/**
 * Frozen contract for POST /generate + registry gate (see server.js banner).
 * If these fail, restoring green here is required before changing routing or validation.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import registryPkg from "../../capability-registry/dist/index.js";
const {
  computeCapabilityDefinitionHash,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  parseDefinitionJson,
  prepareExecutionRequest,
  resolveAuthorityContext,
} = registryPkg;
import { classifyGeneratePrompt } from "../lib/intent-classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_CAPABILITIES = path.join(__dirname, "..", "..", "capabilities");

const particleV2Def = parseDefinitionJson(
  JSON.parse(
    readFileSync(
      path.join(REPO_CAPABILITIES, "hai.particle.update", "2.0.0", "definition.json"),
      "utf8"
    )
  )
);

const silentLoadLogger = {
  info: () => {},
  warn: (m) => console.error(m),
};

function harnessAdmission() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "zak-harness-governance-"));
  return {
    options: {
      authorityContext: resolveAuthorityContext("none", {
        source: "test",
        evaluated_at: "2026-04-06T12:00:00.000Z",
        session_id: "harness-test",
        subject_id: "harness-test",
      }),
      governanceRuntime: createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "harness-core",
        now: () => "2026-04-06T12:00:00.000Z",
      }),
    },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

function harnessRegistry() {
  if (!existsSync(REPO_CAPABILITIES)) {
    throw new Error(`missing compiled capabilities: ${REPO_CAPABILITIES}`);
  }
  return createRegistryFromCompiledCapabilities(REPO_CAPABILITIES, { logger: silentLoadLogger });
}

const CONSTITUTION_ID = "zak-default";

test("frozen: casual greeting → conversation (user-verified shape)", () => {
  const r = classifyGeneratePrompt("hey there, what's going on?");
  assert.equal(r.mode, "conversation");
  assert.equal(r.route, "conversation");
  assert.equal(r.scope, "full");
  assert.equal(r.replyTo, "hey there, what's going on?");
});

test("frozen: draft scaffolding + update instruction → execution", () => {
  const draftPrompt = `You are generating a capability request draft.
Rules:
- capability must be "hai.particle.update"
update particle demo-1 with hue 0.5 and revision 1`;
  const r = classifyGeneratePrompt(draftPrompt);
  assert.equal(r.mode, "execution");
});

test("frozen: validated execution payload pins v2 and definition hash (demo-1 / revision / hue)", () => {
  const admission = harnessAdmission();
  const registry = harnessRegistry();
  const prep = prepareExecutionRequest(registry, {
    capability: "hai.particle.update",
    input: {
      particle_id: "demo-1",
      attributes: { revision: 1, hue: 0.5 },
    },
    context: { constitution_id: CONSTITUTION_ID },
  }, admission.options);
  try {
    assert.equal(prep.ok, true);
    if (!prep.ok) throw new Error("expected ok");
    assert.equal(prep.request.capability_version, "2.0.0");
    assert.equal(prep.request.capability_definition_hash, computeCapabilityDefinitionHash(particleV2Def));
    assert.deepEqual(prep.adapter, { key: "hai-adapter", route: "particle.update" });
  } finally {
    admission.cleanup();
  }
});

test("frozen: hai.particle.update compiled meta reflects mutating Class B contract", () => {
  const registry = harnessRegistry();
  const meta = registry.getCapabilityMeta("hai.particle.update", "2.0.0");
  assert.ok(meta);
  assert.equal(meta.execution_class, "B");
  assert.equal(meta.side_effect_tier, "low");
  assert.equal(meta.idempotency, "none");
  assert.equal(meta.replay_behavior, "blocked");
});
