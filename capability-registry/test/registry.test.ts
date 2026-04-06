import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  computeCapabilityDefinitionHash,
  createRegistryWithBuiltins,
  definitionsForFormShaping,
  haiParticleUpdateV1,
  prepareExecutionRequest,
  type ValidationResult,
  type ZakIdeBridgeRequestDraft,
} from "../src/index";

function assertValid(r: ValidationResult): asserts r is ValidationResult & { valid: true } {
  expect(r.valid).toBe(true);
}

describe("CapabilityRegistry", () => {
  it("prepareExecutionRequest pins explicit capability_version and keeps input unchanged", () => {
    const registry = createRegistryWithBuiltins();
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
    const prep = prepareExecutionRequest(registry, draft);
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error("expected ok");
    expect(prep.request.capability_version).toBe("1.0.0");
    expect(prep.request.input).toBe(draft.input);
    expect(prep.request.capability_definition_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prep.request.capability_definition_hash).toBe(
      computeCapabilityDefinitionHash(haiParticleUpdateV1)
    );
    expect(prep.adapter).toEqual({ key: "hai-adapter", route: "particle.update" });
  });

  it("computeCapabilityDefinitionHash is deterministic for the same definition", () => {
    const a = computeCapabilityDefinitionHash(haiParticleUpdateV1);
    const b = computeCapabilityDefinitionHash(haiParticleUpdateV1);
    expect(a).toBe(b);
  });

  it("prepareExecutionRequest with omitted version resolves latest and pins it on wire", () => {
    const registry = createRegistryWithBuiltins();
    const draft: ZakIdeBridgeRequestDraft = {
      capability: "hai.context.snapshot",
      input: { scope: "user/session" },
      context: { constitution_id: "zak-default" },
    };
    const prep = prepareExecutionRequest(registry, draft);
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error("expected ok");
    expect(prep.request.capability_version).toBe("1.0.0");
    expect(prep.request.capability).toBe("hai.context.snapshot");
  });

  it("invalid shape blocked before ZAKAI (Ajv)", () => {
    const registry = createRegistryWithBuiltins();
    const bad = { particle_id: "", attributes: {} };
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: bad as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) throw new Error("expected fail");
    expect(prep.errors.length).toBeGreaterThan(0);
  });

  it("semantic validation fails when meaning is wrong (hue out of range)", () => {
    const registry = createRegistryWithBuiltins();
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: {
        particle_id: "x",
        attributes: { hue: 1.5 },
      } as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) throw new Error("expected fail");
    expect(prep.errors.some((e) => e.message.includes("hue"))).toBe(true);
  });

  it("semantic validation rejects implausible revision range even if schema drifts", () => {
    const registry = createRegistryWithBuiltins();
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: {
        particle_id: "x",
        attributes: { revision: 2_000_000 },
      } as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "2.0.0",
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) throw new Error("expected fail");
    expect(prep.errors.some((e) => e.message.includes("revision"))).toBe(true);
  });

  it("version selection uses correct schema (v1 vs v2)", () => {
    const registry = createRegistryWithBuiltins();
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

  it("implicit latest in getCapability is not ambiguous on wire when using prepareExecutionRequest", () => {
    const registry = createRegistryWithBuiltins();
    const payloadV1Only = { particle_id: "x", attributes: { label: "a" } };
    const prep = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: payloadV1Only as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) throw new Error("expected fail");
    const prepPinned = prepareExecutionRequest(registry, {
      capability: "hai.particle.update",
      input: payloadV1Only as Record<string, unknown>,
      context: { constitution_id: "zak-default" },
      capability_version: "1.0.0",
    });
    expect(prepPinned.ok).toBe(true);
    if (!prepPinned.ok) throw new Error("expected ok");
    expect(prepPinned.request.capability_version).toBe("1.0.0");
  });

  it("unknown capability fails prepareExecutionRequest", () => {
    const registry = new CapabilityRegistry();
    const prep = prepareExecutionRequest(registry, {
      capability: "does.not.exist",
      input: { any: 1 },
      context: { constitution_id: "zak-default" },
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) throw new Error("expected fail");
    expect(prep.errors.some((e) => e.message.includes("unknown"))).toBe(true);
  });

  it("definitions include adapter binding for host routing", () => {
    const registry = createRegistryWithBuiltins();
    const listed = definitionsForFormShaping(registry);
    for (const d of listed) {
      expect(d.adapter.key).toBeTruthy();
      expect(d.adapter.route).toBeTruthy();
    }
    const binding = registry.lookupAdapterBinding("hai.context.snapshot", "1.0.0");
    expect(binding).toEqual({ key: "hai-adapter", route: "context.snapshot" });
  });
});
