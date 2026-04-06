import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CapabilityCompiledMeta } from "../src/capability-meta";
import {
  CapabilityRegistry,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  executeGovernedCapability,
  prepareExecutionRequest,
  getGovernanceHealthStatus,
} from "../src/index";
import { REPO_CAPABILITIES_ROOT, silentLoadLogger, testAuthorityContext } from "./compiled-fixtures";

function makeRuntime(name: string) {
  const rootDir = mkdtempSync(join(tmpdir(), `zak-governance-${name}-`));
  const runtime = createFileGovernanceRuntime({
    rootDir,
    environmentId: "test",
    runtimeId: name,
    now: () => "2026-04-06T12:00:00.000Z",
  });
  return {
    rootDir,
    runtime,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

describe("executeGovernedCapability", () => {
  it("always validates adapter output (fail-closed) and persists failure receipt", async () => {
    const { runtime, cleanup } = makeRuntime("output-validation");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      const out = await executeGovernedCapability(
        registry,
        {
          capability: "hai.time.get",
          input: { timezone: "UTC" },
          context: { constitution_id: "x" },
          capability_version: "1.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: runtime,
          invokeAdapter: () => ({ timezone: "UTC" }),
        }
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected fail");
      expect(out.stage).toBe("output_validation");
      expect(out.receipt?.success).toBe(false);
      expect(out.receipt?.stage).toBe("output_validation");
      expect(runtime.listRecentReceipts(1)[0]?.stage).toBe("output_validation");
    } finally {
      cleanup();
    }
  });

  it("successful Class A execution persists a chain-verifiable receipt", async () => {
    const { runtime, cleanup } = makeRuntime("class-a");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      const out = await executeGovernedCapability(
        registry,
        {
          capability: "hai.time.get",
          input: { timezone: "UTC" },
          context: { constitution_id: "x" },
          capability_version: "1.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: runtime,
          invokeAdapter: () => ({
            timezone: "UTC",
            utc_iso: "2026-01-01T00:00:00.000Z",
            local_display: "Thu, 1 January 2026, 00:00:00 UTC",
          }),
        }
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected ok");
      expect(out.stage).toBe("executed");
      expect(out.receipt.capability).toBe("hai.time.get");
      expect(out.receipt.version).toBe("1.0.0");
      expect(out.receipt.capability_definition_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(out.receipt.authority_level_used).toBe("none");
      expect(out.receipt.authority.source).toBe("resolved:test");
      expect(out.receipt.execution_class).toBe("A");
      expect(out.receipt.timestamp).toBe("2026-04-06T12:00:00.000Z");
      expect(out.receipt.output_validation_passed).toBe(true);
      expect(out.receipt.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(out.receipt.prev_receipt_hash).toBe(null);
      expect(runtime.verifyReceiptChain().ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("successful Class B execution persists receipt and replay consumption", async () => {
    const { runtime, cleanup } = makeRuntime("class-b");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const meta = registry.getCapabilityMeta("hai.particle.update", "2.0.0");
    try {
      const out = await executeGovernedCapability(
        registry,
        {
          capability: "hai.particle.update",
          input: {
            particle_id: "demo-1",
            attributes: { revision: 1, hue: 0.5 },
          },
          context: { constitution_id: "x" },
          capability_version: "2.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: runtime,
          invokeAdapter: () => ({ ok: "harness_stub" }),
        }
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected ok");
      expect(out.stage).toBe("executed");
      expect(out.receipt.execution_class).toBe(meta?.execution_class);
      expect(out.receipt.replay_key).toBeTruthy();
      expect(runtime.listReplayEntries(10)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("authority is resolved from request context instead of trusting forged injected fields", async () => {
    const { runtime, cleanup } = makeRuntime("authority-resolve");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      const out = await executeGovernedCapability(
        registry,
        {
          capability: "hai.time.get",
          input: { timezone: "UTC" },
          context: {
            constitution_id: "x",
            session_id: "ctx-session",
            subject_id: "ctx-subject",
          },
          capability_version: "1.0.0",
        },
        {
          authorityContext: {
            ...testAuthorityContext(),
            session_id: "forged-session",
            subject_id: "forged-subject",
          },
          governanceRuntime: runtime,
          invokeAdapter: () => ({
            timezone: "UTC",
            utc_iso: "2026-01-01T00:00:00.000Z",
            local_display: "Thu, 1 January 2026, 00:00:00 UTC",
          }),
        }
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected ok");
      expect(out.receipt.authority.session_id).toBe("ctx-session");
      expect(out.receipt.authority.subject_id).toBe("ctx-subject");
      expect(out.receipt.authority.source).toBe("resolved:test");
    } finally {
      cleanup();
    }
  });

  it("blocked replay survives restart", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-restart-"));
    const runtimeA = createFileGovernanceRuntime({
      rootDir,
      environmentId: "test",
      runtimeId: "restart",
      now: () => "2026-04-06T12:00:00.000Z",
    });
    const registry = new CapabilityRegistry();
    const def = {
      capability: "test.b.replay",
      version: "1.0.0",
      adapter: { key: "k", route: "b.replay" },
      input_schema: { type: "object" },
    };
    const meta: CapabilityCompiledMeta = {
      authority_requirements: "none",
      execution_class: "B",
      side_effect_tier: "low",
      idempotency: "inherent",
      replay_behavior: "blocked",
      output_schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    };
    registry.registerCapability(def);
    registry.registerCapabilityMeta(def.capability, def.version, meta);
    const draft = {
      capability: def.capability,
      input: { x: 1 } as Record<string, unknown>,
      context: { constitution_id: "c" },
      capability_version: def.version,
    };

    try {
      const first = await executeGovernedCapability(registry, draft, {
        authorityContext: testAuthorityContext(),
        governanceRuntime: runtimeA,
        invokeAdapter: () => ({ ok: true }),
      });
      expect(first.ok).toBe(true);

      const runtimeB = createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "restart",
        now: () => "2026-04-06T12:00:01.000Z",
      });
      const second = await executeGovernedCapability(registry, draft, {
        authorityContext: testAuthorityContext(),
        governanceRuntime: runtimeB,
        invokeAdapter: () => ({ ok: true }),
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected fail");
      expect(second.stage).toBe("admission");
      expect(second.errors.some((e) => e.message.includes("replay blocked"))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("receipt chain continuity detects tampering", async () => {
    const { rootDir, runtime, cleanup } = makeRuntime("chain");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      const one = await executeGovernedCapability(
        registry,
        {
          capability: "hai.time.get",
          input: { timezone: "UTC" },
          context: { constitution_id: "x" },
          capability_version: "1.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: runtime,
          invokeAdapter: () => ({
            timezone: "UTC",
            utc_iso: "2026-01-01T00:00:00.000Z",
            local_display: "Thu, 1 January 2026, 00:00:00 UTC",
          }),
        }
      );
      expect(one.ok).toBe(true);
      const two = await executeGovernedCapability(
        registry,
        {
          capability: "hai.context.snapshot",
          input: { scope: "test" },
          context: { constitution_id: "x" },
          capability_version: "1.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: runtime,
          invokeAdapter: () => ({ scope: "test", snapshot: {} }),
        }
      );
      expect(two.ok).toBe(true);
      expect(runtime.verifyReceiptChain().ok).toBe(true);

      const receiptPath = join(rootDir, "receipts.jsonl");
      const lines = readFileSync(receiptPath, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!);
      last.prev_receipt_hash = "sha256:deadbeef";
      lines[lines.length - 1] = JSON.stringify(last);
      writeFileSync(receiptPath, `${lines.join("\n")}\n`, "utf8");

      const tampered = createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "chain",
        now: () => "2026-04-06T12:00:00.000Z",
      });
      expect(tampered.verifyReceiptChain().ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("receipt persistence failure fails closed for Class B", async () => {
    const { runtime, cleanup } = makeRuntime("receipt-fail");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      const out = await executeGovernedCapability(
        registry,
        {
          capability: "hai.particle.update",
          input: {
            particle_id: "demo-1",
            attributes: { revision: 2, hue: 0.4 },
          },
          context: { constitution_id: "x" },
          capability_version: "2.0.0",
        },
        {
          authorityContext: testAuthorityContext(),
          governanceRuntime: {
            ...runtime,
            assertStartupInvariants: () => {},
            now: () => runtime.now(),
            hasBlockedReplay: (...args) => runtime.hasBlockedReplay(...args),
            lookupIdempotencyKey: (...args) => runtime.lookupIdempotencyKey(...args),
            persistReceipt: () => {
              throw new Error("disk full");
            },
          },
          invokeAdapter: () => ({ ok: "harness_stub" }),
        }
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected fail");
      expect(out.stage).toBe("receipt_persistence");
    } finally {
      cleanup();
    }
  });

  it("allowed_same_key permits same input with same idempotency key but blocks key reuse with different input", async () => {
    const { runtime, cleanup } = makeRuntime("allowed-same-key");
    const registry = new CapabilityRegistry();
    const def = {
      capability: "test.b.idempotent",
      version: "1.0.0",
      adapter: { key: "k", route: "b.idempotent" },
      input_schema: {
        type: "object",
        required: ["value", "idempotency_key"],
        properties: {
          value: { type: "number" },
          idempotency_key: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    };
    const meta: CapabilityCompiledMeta = {
      authority_requirements: "none",
      execution_class: "B",
      side_effect_tier: "low",
      idempotency: "keyed",
      replay_behavior: "allowed_same_key",
      output_schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    };
    registry.registerCapability(def);
    registry.registerCapabilityMeta(def.capability, def.version, meta);
    const base = {
      capability: def.capability,
      context: { constitution_id: "c", session_id: "idem-session" },
      capability_version: def.version,
    };
    try {
      const first = await executeGovernedCapability(registry, {
        ...base,
        input: { value: 1, idempotency_key: "idem-1" },
      }, {
        authorityContext: testAuthorityContext(),
        governanceRuntime: runtime,
        invokeAdapter: () => ({ ok: true }),
      });
      expect(first.ok).toBe(true);

      const second = await executeGovernedCapability(registry, {
        ...base,
        input: { value: 1, idempotency_key: "idem-1" },
      }, {
        authorityContext: testAuthorityContext(),
        governanceRuntime: runtime,
        invokeAdapter: () => ({ ok: true }),
      });
      expect(second.ok).toBe(true);

      const third = await executeGovernedCapability(registry, {
        ...base,
        input: { value: 2, idempotency_key: "idem-1" },
      }, {
        authorityContext: testAuthorityContext(),
        governanceRuntime: runtime,
        invokeAdapter: () => ({ ok: true }),
      });
      expect(third.ok).toBe(false);
      if (third.ok) throw new Error("expected fail");
      expect(third.errors.some((e) => e.message.includes("idempotency_key reuse"))).toBe(true);
      expect(getGovernanceHealthStatus(registry, runtime).ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("prepareExecutionRequest authorityContext", () => {
  it("fails closed when authorityContext is undefined at runtime", () => {
    const { runtime, cleanup } = makeRuntime("prepare");
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const prep = prepareExecutionRequest(
      registry,
      {
        capability: "hai.time.get",
        input: {},
        context: { constitution_id: "t" },
        capability_version: "1.0.0",
      },
      { authorityContext: undefined as never, governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(false);
      if (prep.ok) throw new Error("expected fail");
      expect(prep.stage).toBe("admission");
      expect(prep.errors[0]!.message).toContain("authorityContext is required");
    } finally {
      cleanup();
    }
  });
});
