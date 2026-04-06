import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  computeCapabilityDefinitionHash,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  definitionsForFormShaping,
  prepareExecutionRequest,
  semanticParticleUpdateV2,
  type ValidationResult,
  type ZakIdeBridgeRequestDraft,
} from "../src/index";
import {
  definitionFromCompiledFlat,
  definitionFromCompiledVersioned,
  REPO_CAPABILITIES_ROOT,
  silentLoadLogger,
  testAuthorityContext,
} from "./compiled-fixtures";

function assertValid(r: ValidationResult): asserts r is ValidationResult & { valid: true } {
  expect(r.valid).toBe(true);
}

function makeRegistry() {
  return createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
    logger: silentLoadLogger,
  });
}

const particleV1 = definitionFromCompiledVersioned("hai.particle.update", "1.0.0");
const timeGetV1 = definitionFromCompiledFlat("hai.time.get");

function admissionHost() {
  const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-registry-"));
  return {
    options: {
      authorityContext: testAuthorityContext(),
      governanceRuntime: createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "registry",
        now: () => "2026-04-06T12:00:00.000Z",
      }),
    },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

describe("CapabilityRegistry", () => {
  it("prepareExecutionRequest pins explicit capability_version and keeps input unchanged", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const input = {
      particle_id: "p-1",
      attributes: { hue: 0.5 },
      timestamp: "2026-04-06T00:00:00Z",
    };
    const draft: ZakIdeBridgeRequestDraft = {
      capability: "hai.particle.update",
      input: input as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    };
    const prep = prepareExecutionRequest(registry, draft, host.options);
    try {
      expect(prep.ok).toBe(true);
      if (!prep.ok) throw new Error("expected ok");
      expect(prep.request.capability_version).toBe("1.0.0");
      expect(prep.request.input).toBe(draft.input);
      expect(prep.request.capability_definition_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(prep.request.capability_definition_hash).toBe(computeCapabilityDefinitionHash(particleV1));
      expect(prep.adapter).toEqual({ key: "hai-adapter", route: "particle.update" });
    } finally {
      host.cleanup();
    }
  });

  it("computeCapabilityDefinitionHash is deterministic for the same definition", () => {
    const a = computeCapabilityDefinitionHash(particleV1);
    const b = computeCapabilityDefinitionHash(particleV1);
    expect(a).toBe(b);
  });

  it("prepareExecutionRequest with omitted version resolves latest and pins it on wire", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const draft: ZakIdeBridgeRequestDraft = {
      capability: "hai.context.snapshot",
      input: { scope: "user/session" },
      context: { constitution_id: "zak-default" },
    };
    const prep = prepareExecutionRequest(registry, draft, host.options);
    try {
      expect(prep.ok).toBe(true);
      if (!prep.ok) throw new Error("expected ok");
      expect(prep.request.capability_version).toBe("1.0.0");
      expect(prep.request.capability).toBe("hai.context.snapshot");
    } finally {
      host.cleanup();
    }
  });

  it("prepareExecutionRequest hai.time.get empty input and optional timezone", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const prepEmpty = prepareExecutionRequest(registry, {
      capability: "hai.time.get",
      input: {} as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    }, host.options);
    expect(prepEmpty.ok).toBe(true);
    if (!prepEmpty.ok) throw new Error("expected ok");
    expect(prepEmpty.request.capability_definition_hash).toBe(computeCapabilityDefinitionHash(timeGetV1));
    expect(prepEmpty.adapter).toEqual({ key: "hai-adapter", route: "time.get" });

    const prepTz = prepareExecutionRequest(registry, {
      capability: "hai.time.get",
      input: { timezone: "UTC" } as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    }, host.options);
    try {
      expect(prepTz.ok).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("invalid shape blocked before ZAKAI (Ajv)", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const bad = { particle_id: "", attributes: {} };
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: bad as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    }, host.options);
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.errors.length).toBeGreaterThan(0);
    } finally {
      host.cleanup();
    }
  });

  it("semantic validation fails when meaning is wrong (hue out of range)", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: {
        particle_id: "x",
        attributes: { hue: 1.5 },
      } as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    }, host.options);
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.errors.some((e) => e.message.includes("hue"))).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("semantic validation rejects implausible revision range even if schema drifts", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: {
        particle_id: "x",
        attributes: { revision: 2_000_000 },
      } as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "2.0.0",
    }, host.options);
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.errors.some((e) => e.message.includes("revision"))).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("version selection uses correct schema (v1 vs v2)", () => {
    const registry = makeRegistry();
    const payload = { particle_id: "x", attributes: { label: "a" } };

    const v1 = registry.validateInput("hai.particle.update", payload, "1.0.0");
    assertValid(v1);

    const v2 = registry.validateInput("hai.particle.update", payload, "2.0.0");
    expect(v2.valid).toBe(false);

    const v2ok = registry.validateInput(
      "hai.particle.update",
      {
        particle_id: "x",
        attributes: { revision: 1, label: "a" },
      },
      "2.0.0"
    );
    assertValid(v2ok);
  });

  describe("hai.particle.update v2 attributes.hue", () => {
    const cap = "hai.particle.update" as const;
    const v = "2.0.0" as const;

    it("accepts revision only", () => {
      const registry = makeRegistry();
      assertValid(
        registry.validateInput(cap, { particle_id: "x", attributes: { revision: 0 } }, v)
      );
    });

    it("accepts revision and hue in [0, 1]", () => {
      const registry = makeRegistry();
      assertValid(
        registry.validateInput(cap, { particle_id: "x", attributes: { revision: 1, hue: 0.5 } }, v)
      );
    });

    it("rejects hue below 0 (schema)", () => {
      const registry = makeRegistry();
      const r = registry.validateInput(
        cap,
        { particle_id: "x", attributes: { revision: 1, hue: -0.01 } },
        v
      );
      expect(r.valid).toBe(false);
    });

    it("rejects hue above 1 (schema)", () => {
      const registry = makeRegistry();
      const r = registry.validateInput(
        cap,
        { particle_id: "x", attributes: { revision: 1, hue: 1.01 } },
        v
      );
      expect(r.valid).toBe(false);
    });

    it("rejects hue when not a number (Ajv type)", () => {
      const registry = makeRegistry();
      const r = registry.validateInput(
        cap,
        { particle_id: "x", attributes: { revision: 1, hue: "0.5" } } as Record<string, unknown>,
        v
      );
      expect(r.valid).toBe(false);
      if (r.valid) throw new Error("expected fail");
      expect(
        r.errors.some(
          (e) =>
            (e.path !== undefined && e.path.includes("hue")) ||
            e.message.toLowerCase().includes("hue")
        )
      ).toBe(true);
    });

    it("rejects non-finite hue when present (Ajv min/max)", () => {
      const registry = makeRegistry();
      const r = registry.validateInput(
        cap,
        { particle_id: "x", attributes: { revision: 1, hue: Number.NaN } },
        v
      );
      expect(r.valid).toBe(false);
      if (r.valid) throw new Error("expected fail");
      expect(r.errors.some((e) => e.path?.includes("hue"))).toBe(true);
    });

    it("semanticParticleUpdateV2 rejects hue string, NaN, and out-of-range when key present", () => {
      const base = { particle_id: "x", attributes: { revision: 0 } };
      expect(
        semanticParticleUpdateV2({
          ...base,
          attributes: { revision: 0, hue: "0.5" },
        }).valid
      ).toBe(false);
      const nan = semanticParticleUpdateV2({
        ...base,
        attributes: { revision: 0, hue: Number.NaN },
      });
      expect(nan.valid).toBe(false);
      expect(nan.errors?.some((m) => m.includes("finite"))).toBe(true);
      const hi = semanticParticleUpdateV2({
        ...base,
        attributes: { revision: 0, hue: 1.1 },
      });
      expect(hi.valid).toBe(false);
    });

    it("rejects missing revision", () => {
      const registry = makeRegistry();
      const r = registry.validateInput(
        cap,
        { particle_id: "x", attributes: { hue: 0.5 } },
        v
      );
      expect(r.valid).toBe(false);
    });
  });

  it("implicit latest in getCapability is not ambiguous on wire when using prepareExecutionRequest", () => {
    const host = admissionHost();
    const registry = makeRegistry();
    const payloadV1Only = { particle_id: "x", attributes: { label: "a" } };
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: payloadV1Only as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
    }, host.options);
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      const prepPinned = prepareExecutionRequest(registry, {
        capability: "hai.particle.update",
        input: payloadV1Only as Record<string, unknown>,
        context: { constitution_id: "zak-default" },
        capability_version: "1.0.0",
      }, host.options);
      expect(prepPinned.ok).toBe(true);
      if (!prepPinned.ok) throw new Error("expected ok");
      expect(prepPinned.request.capability_version).toBe("1.0.0");
    } finally {
      host.cleanup();
    }
  });

  it("unknown capability fails prepareExecutionRequest", () => {
    const host = admissionHost();
    const registry = new CapabilityRegistry();
    const prep = prepareExecutionRequest(registry, {
      capability: "does.not.exist",
      input: { any: 1 },
      context: { constitution_id: "zak-default" },
    }, host.options);
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.errors.some((e) => e.message.includes("unknown"))).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("definitions include adapter binding for host routing", () => {
    const registry = makeRegistry();
    const listed = definitionsForFormShaping(registry);
    for (const d of listed) {
      expect(d.adapter.key).toBeTruthy();
      expect(d.adapter.route).toBeTruthy();
    }
    const binding = registry.lookupAdapterBinding("hai.context.snapshot", "1.0.0");
    expect(binding).toEqual({ key: "hai-adapter", route: "context.snapshot" });
  });
});
