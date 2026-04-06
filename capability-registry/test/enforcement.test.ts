import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  checkAdmissionPolicy,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  loadCapabilityBundlesFromDirectory,
  parseCapabilityCompiledMeta,
  prepareExecutionRequest,
  resolveAuthorityContext,
  resolveExecutionAuthorityContext,
  validateAdapterOutput,
  validateAdapterOutputForCapability,
} from "../src/index";
import type { CapabilityCompiledMeta } from "../src/capability-meta";
import { REPO_CAPABILITIES_ROOT, silentLoadLogger, testAuthorityContext } from "./compiled-fixtures";

function makeRuntime() {
  const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-enforcement-"));
  return {
    runtime: createFileGovernanceRuntime({
      rootDir,
      environmentId: "test",
      runtimeId: "enforcement",
      now: () => "2026-04-06T12:00:00.000Z",
    }),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

describe("admission authority + class policy", () => {
  it("rejects when admission_authority below authority_requirements", () => {
    const { runtime, cleanup } = makeRuntime();
    const bundles = loadCapabilityBundlesFromDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const time = bundles.find((b) => b.definition.capability === "hai.time.get")!;
    const meta: CapabilityCompiledMeta = {
      ...time.meta,
      authority_requirements: "standard",
    };
    const r = new CapabilityRegistry();
    r.registerCapability(time.definition);
    r.registerCapabilityMeta(time.definition.capability, time.definition.version, meta);

    const prep = prepareExecutionRequest(
      r,
      {
        capability: "hai.time.get",
        input: {},
        context: { constitution_id: "t" },
        capability_version: "1.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.errors.some((e) => e.message.includes("insufficient"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("allows elevated when requirement is standard", () => {
    const { runtime, cleanup } = makeRuntime();
    const bundles = loadCapabilityBundlesFromDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const time = bundles.find((b) => b.definition.capability === "hai.time.get")!;
    const meta: CapabilityCompiledMeta = {
      ...time.meta,
      authority_requirements: "standard",
    };
    const r = new CapabilityRegistry();
    r.registerCapability(time.definition);
    r.registerCapabilityMeta(time.definition.capability, time.definition.version, meta);

    const prep = prepareExecutionRequest(
      r,
      {
        capability: "hai.time.get",
        input: {},
        context: { constitution_id: "t" },
        capability_version: "1.0.0",
      },
      {
        authorityContext: resolveAuthorityContext("elevated", {
          source: "test",
          evaluated_at: "2026-04-06T12:00:00.000Z",
        }),
        governanceRuntime: runtime,
      }
    );
    try {
      expect(prep.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("Class C fails when async contract missing in meta", () => {
    const { runtime, cleanup } = makeRuntime();
    const meta: CapabilityCompiledMeta = {
      authority_requirements: "none",
      execution_class: "C",
      output_schema: { type: "object" },
    };
    const r = new CapabilityRegistry();
    r.registerCapability({
      capability: "test.async",
      version: "1.0.0",
      adapter: { key: "k", route: "r" },
      input_schema: { type: "object" },
    });
    r.registerCapabilityMeta("test.async", "1.0.0", meta);

    const prep = prepareExecutionRequest(
      r,
      {
        capability: "test.async",
        input: {},
        context: { constitution_id: "t" },
        capability_version: "1.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.stage).toBe("admission");
      expect(prep.errors.some((e) => e.message.includes("async_model"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("Class B meta missing mutating fields fails admission", () => {
    const { runtime, cleanup } = makeRuntime();
    const meta = {
      authority_requirements: "none",
      execution_class: "B",
      output_schema: { type: "object", properties: { ok: { type: "string" } }, required: ["ok"] },
    } as CapabilityCompiledMeta;
    const r = new CapabilityRegistry();
    r.registerCapability({
      capability: "test.b",
      version: "1.0.0",
      adapter: { key: "k", route: "b" },
      input_schema: { type: "object" },
    });
    r.registerCapabilityMeta("test.b", "1.0.0", meta);

    const prep = prepareExecutionRequest(
      r,
      {
        capability: "test.b",
        input: {},
        context: { constitution_id: "t" },
        capability_version: "1.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.stage).toBe("admission");
      expect(prep.errors.some((e) => e.message.includes("side_effect_tier"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("parseCapabilityCompiledMeta rejects Class B without side_effect_tier", () => {
    expect(() =>
      parseCapabilityCompiledMeta({
        authority_requirements: "none",
        execution_class: "B",
        output_schema: { type: "object" },
      })
    ).toThrow(/side_effect_tier/);
  });

  it("parseCapabilityCompiledMeta rejects Class A with mutating replay fields", () => {
    expect(() =>
      parseCapabilityCompiledMeta({
        authority_requirements: "none",
        execution_class: "A",
        replay_behavior: "blocked",
        output_schema: { type: "object" },
      })
    ).toThrow(/replay_behavior/);
  });

  it("parseCapabilityCompiledMeta rejects Class C with Class B mutating fields", () => {
    expect(() =>
      parseCapabilityCompiledMeta({
        authority_requirements: "none",
        execution_class: "C",
        async_model: "poll",
        job_id_field: "job_id",
        partial_receipt: true,
        side_effect_tier: "low",
        output_schema: { type: "object" },
      })
    ).toThrow(/side_effect_tier/);
  });

  it("compiled hai.particle.update is classified as Class B with required mutating meta", () => {
    const bundle = loadCapabilityBundlesFromDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    }).find((b) => b.definition.capability === "hai.particle.update" && b.definition.version === "2.0.0");
    expect(bundle).toBeDefined();
    expect(bundle?.meta.execution_class).toBe("B");
    expect(bundle?.meta.side_effect_tier).toBe("low");
    expect(bundle?.meta.idempotency).toBe("none");
    expect(bundle?.meta.replay_behavior).toBe("blocked");
  });

  it("continuous_resonance_required fails until host asserts continuous_resonance", () => {
    const meta = parseCapabilityCompiledMeta({
      generated_by: "test",
      authority_requirements: "continuous_resonance_required",
      execution_class: "A",
      output_schema: { type: "object" },
    });
    const errs = checkAdmissionPolicy(meta, resolveAuthorityContext("elevated", {
      source: "test",
      evaluated_at: "2026-04-06T12:00:00.000Z",
    }));
    expect(errs.length).toBeGreaterThan(0);
    const ok = checkAdmissionPolicy(meta, resolveAuthorityContext("continuous_resonance", {
      source: "test",
      evaluated_at: "2026-04-06T12:00:00.000Z",
    }));
    expect(ok.length).toBe(0);
  });

  it("rejects malformed authority provenance before rank evaluation", () => {
    const meta = parseCapabilityCompiledMeta({
      generated_by: "test",
      authority_requirements: "none",
      execution_class: "A",
      output_schema: { type: "object" },
    });
    const errs = checkAdmissionPolicy(meta, {
      resolved_authority_level: "none",
      source: "",
      evaluated_at: "",
    });
    expect(errs.some((e) => e.message.includes("authorityContext.source"))).toBe(true);
    expect(errs.some((e) => e.message.includes("authorityContext.evaluated_at"))).toBe(true);
  });
});

describe("resolveExecutionAuthorityContext", () => {
  it("carries authority_context_id from draft.context into resolved authority", () => {
    const { runtime, cleanup } = makeRuntime();
    try {
      const resolved = resolveExecutionAuthorityContext(
        {
          capability: "hai.time.get",
          input: {},
          context: {
            constitution_id: "t",
            session_id: "sess-1",
            subject_id: "sub-1",
            authority_context_id: "arc-alpha",
          },
        },
        runtime,
        resolveAuthorityContext("none", {
          source: "seed",
          evaluated_at: "2026-04-06T12:00:00.000Z",
        }),
      );
      expect(resolved.session_id).toBe("sess-1");
      expect(resolved.subject_id).toBe("sub-1");
      expect(resolved.authority_context_id).toBe("arc-alpha");
    } finally {
      cleanup();
    }
  });

  it("prefers draft.context authority_context_id over seed", () => {
    const { runtime, cleanup } = makeRuntime();
    try {
      const resolved = resolveExecutionAuthorityContext(
        {
          capability: "hai.time.get",
          input: {},
          context: {
            constitution_id: "t",
            authority_context_id: "from-draft",
          },
        },
        runtime,
        resolveAuthorityContext("none", {
          source: "seed",
          evaluated_at: "2026-04-06T12:00:00.000Z",
          authority_context_id: "from-seed",
        }),
      );
      expect(resolved.authority_context_id).toBe("from-draft");
    } finally {
      cleanup();
    }
  });
});

describe("adapter output validation", () => {
  it("accepts hai.time.get shaped payload against meta", () => {
    const time = loadCapabilityBundlesFromDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    }).find((b) => b.definition.capability === "hai.time.get")!;
    const v = validateAdapterOutput("hai.time.get", "1.0.0", time.meta, {
      timezone: "UTC",
      utc_iso: "2026-01-01T00:00:00.000Z",
      local_display: "Thu, 1 January 2026, 00:00:00 UTC",
    });
    expect(v.valid).toBe(true);
  });

  it("rejects output missing required fields", () => {
    const r = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const v = validateAdapterOutputForCapability(r, "hai.time.get", "1.0.0", {
      timezone: "UTC",
    });
    expect(v.valid).toBe(false);
    if (v.valid) throw new Error("expected fail");
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("registry wrapper returns error when meta missing", () => {
    const r = new CapabilityRegistry();
    const v = validateAdapterOutputForCapability(r, "none", "1.0.0", {});
    expect(v.valid).toBe(false);
  });
});
