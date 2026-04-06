import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertGovernanceStartupInvariants,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  getGovernanceHealthStatus,
} from "../src/index";
import { REPO_CAPABILITIES_ROOT, silentLoadLogger, testAuthorityContext } from "./compiled-fixtures";

describe("governance runtime invariants", () => {
  it("rejects malformed receipt journal state on startup", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-corrupt-"));
    try {
      writeFileSync(join(rootDir, "receipts.jsonl"), '{"bad":\n', "utf8");
      expect(() =>
        createFileGovernanceRuntime({
          rootDir,
          environmentId: "test",
          runtimeId: "corrupt",
        })
      ).toThrow(/invalid JSON on line 1/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("startup invariants fail closed on a tampered receipt chain", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-chain-startup-"));
    const runtimeA = createFileGovernanceRuntime({
      rootDir,
      environmentId: "test",
      runtimeId: "chain-startup",
      now: () => "2026-04-06T12:00:00.000Z",
    });
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    try {
      runtimeA.persistReceipt({
        capability: "hai.time.get",
        version: "1.0.0",
        capability_definition_hash: "sha256:test",
        authority: testAuthorityContext(),
        execution_class: "A",
        stage: "executed",
        success: true,
        output_validation_passed: true,
      });
      runtimeA.persistReceipt({
        capability: "hai.context.snapshot",
        version: "1.0.0",
        capability_definition_hash: "sha256:test2",
        authority: testAuthorityContext(),
        execution_class: "A",
        stage: "executed",
        success: true,
        output_validation_passed: true,
      });

      const path = join(rootDir, "receipts.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!);
      last.prev_receipt_hash = "sha256:tampered";
      lines[lines.length - 1] = JSON.stringify(last);
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

      const runtimeB = createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "chain-startup",
      });
      expect(runtimeB.startupInvariants().some((inv) => inv.target === "receipt_chain" && !inv.ok)).toBe(true);
      expect(() => assertGovernanceStartupInvariants(registry, runtimeB)).toThrow(/receipt_chain/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("health status reports anchor mismatch deterministically", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zak-governance-anchor-"));
    const registry = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const runtime = createFileGovernanceRuntime({
      rootDir,
      environmentId: "test",
      runtimeId: "anchor",
      now: () => "2026-04-06T12:00:00.000Z",
    });
    try {
      runtime.persistReceipt({
        capability: "hai.time.get",
        version: "1.0.0",
        capability_definition_hash: "sha256:test",
        authority: testAuthorityContext(),
        execution_class: "A",
        stage: "executed",
        success: true,
        output_validation_passed: true,
      });
      const path = join(rootDir, "anchors.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!);
      last.anchored_receipt_hash = "sha256:forged";
      lines[lines.length - 1] = JSON.stringify(last);
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

      const runtimeB = createFileGovernanceRuntime({
        rootDir,
        environmentId: "test",
        runtimeId: "anchor",
      });
      const health = getGovernanceHealthStatus(registry, runtimeB);
      expect(health.ok).toBe(false);
      expect(health.reasons.some((r) => r.includes("receipt_anchor"))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
