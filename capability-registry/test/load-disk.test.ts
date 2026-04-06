import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  computeCapabilityDefinitionHash,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  loadDefinitionsFromCapabilitiesDirectory,
  parseDefinitionJson,
  prepareExecutionRequest,
} from "../src/index";
import {
  definitionFromCompiledFlat,
  definitionFromCompiledVersioned,
  REPO_CAPABILITIES_ROOT,
  silentLoadLogger,
  testAuthorityContext,
} from "./compiled-fixtures";

describe("loadDefinitionsFromCapabilitiesDirectory", () => {
  it("loads all compiled capabilities from repo tree (flat + nested)", () => {
    const defs = loadDefinitionsFromCapabilitiesDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    expect(defs.length).toBe(4);
    const ids = new Set(defs.map((d) => `${d.capability}@${d.version}`));
    expect(ids.has("hai.time.get@1.0.0")).toBe(true);
    expect(ids.has("hai.context.snapshot@1.0.0")).toBe(true);
    expect(ids.has("hai.particle.update@1.0.0")).toBe(true);
    expect(ids.has("hai.particle.update@2.0.0")).toBe(true);
  });

  it("compiled particle v1 matches disk JSON", () => {
    const fromDisk = definitionFromCompiledVersioned("hai.particle.update", "1.0.0");
    const listed = loadDefinitionsFromCapabilitiesDirectory(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    }).find((d) => d.capability === "hai.particle.update" && d.version === "1.0.0");
    expect(listed).toEqual(fromDisk);
  });

  it("folder name must match definition.capability (flat)", () => {
    const root = mkdtempSync(join(tmpdir(), "zak-cap-"));
    try {
      const badDir = join(root, "wrong.name");
      mkdirSync(badDir, { recursive: true });
      const ref = definitionFromCompiledFlat("hai.time.get");
      writeFileSync(join(badDir, "definition.json"), `${JSON.stringify(ref)}\n`);
      writeFileSync(
        join(badDir, "definition.hash"),
        `${computeCapabilityDefinitionHash(ref)}\n`
      );
      expect(() =>
        loadDefinitionsFromCapabilitiesDirectory(root, { logger: silentLoadLogger })
      ).toThrow(/folder name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mixed flat and versioned compiled layouts for the same capability", () => {
    const root = mkdtempSync(join(tmpdir(), "zak-cap-mixed-"));
    try {
      const capDir = join(root, "hai.time.get");
      mkdirSync(join(capDir, "1.0.0"), { recursive: true });
      const ref = definitionFromCompiledFlat("hai.time.get");
      writeFileSync(join(capDir, "definition.json"), `${JSON.stringify(ref)}\n`);
      writeFileSync(join(capDir, "definition.hash"), `${computeCapabilityDefinitionHash(ref)}\n`);
      writeFileSync(
        join(capDir, "meta.json"),
        JSON.stringify({
          authority_requirements: "none",
          execution_class: "A",
          output_schema: { type: "object" },
        })
      );
      writeFileSync(join(capDir, "1.0.0", "definition.json"), `${JSON.stringify(ref)}\n`);
      writeFileSync(join(capDir, "1.0.0", "definition.hash"), `${computeCapabilityDefinitionHash(ref)}\n`);
      writeFileSync(
        join(capDir, "1.0.0", "meta.json"),
        JSON.stringify({
          authority_requirements: "none",
          execution_class: "A",
          output_schema: { type: "object" },
        })
      );
      expect(() =>
        createRegistryFromCompiledCapabilities(root, { logger: silentLoadLogger })
      ).toThrow(/cannot have both definition.json and versioned subfolders/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects versioned artifact when folder version and definition.version diverge", () => {
    const root = mkdtempSync(join(tmpdir(), "zak-cap-version-mismatch-"));
    try {
      const capDir = join(root, "hai.time.get", "9.9.9");
      mkdirSync(capDir, { recursive: true });
      const ref = definitionFromCompiledFlat("hai.time.get");
      writeFileSync(join(capDir, "definition.json"), `${JSON.stringify(ref)}\n`);
      writeFileSync(join(capDir, "definition.hash"), `${computeCapabilityDefinitionHash(ref)}\n`);
      writeFileSync(
        join(capDir, "meta.json"),
        JSON.stringify({
          authority_requirements: "none",
          execution_class: "A",
          output_schema: { type: "object" },
        })
      );
      expect(() =>
        createRegistryFromCompiledCapabilities(root, { logger: silentLoadLogger })
      ).toThrow(/must equal definition.version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid governed meta artifacts on load", () => {
    const root = mkdtempSync(join(tmpdir(), "zak-cap-bad-meta-"));
    try {
      const capDir = join(root, "hai.time.get");
      mkdirSync(capDir, { recursive: true });
      const ref = definitionFromCompiledFlat("hai.time.get");
      writeFileSync(join(capDir, "definition.json"), `${JSON.stringify(ref)}\n`);
      writeFileSync(join(capDir, "definition.hash"), `${computeCapabilityDefinitionHash(ref)}\n`);
      writeFileSync(
        join(capDir, "meta.json"),
        JSON.stringify({
          authority_requirements: "none",
          execution_class: "A",
        })
      );
      expect(() =>
        createRegistryFromCompiledCapabilities(root, { logger: silentLoadLogger })
      ).toThrow(/output_schema/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("createRegistryFromCompiledCapabilities matches prepareExecutionRequest for hai.time.get", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "zak-governance-load-"));
    const r = createRegistryFromCompiledCapabilities(REPO_CAPABILITIES_ROOT, {
      logger: silentLoadLogger,
    });
    const runtime = createFileGovernanceRuntime({
      rootDir: runtimeRoot,
      environmentId: "test",
      runtimeId: "load-disk",
      now: () => "2026-04-06T12:00:00.000Z",
    });
    const prep = prepareExecutionRequest(
      r,
      {
        capability: "hai.time.get",
        input: {},
        context: { constitution_id: "x" },
        capability_version: "1.0.0",
      },
      { authorityContext: testAuthorityContext(), governanceRuntime: runtime }
    );
    try {
      expect(prep.ok).toBe(true);
      if (!prep.ok) throw new Error("expected ok");
      expect(prep.request.capability_definition_hash).toBe(
        computeCapabilityDefinitionHash(definitionFromCompiledFlat("hai.time.get"))
      );
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("parseDefinitionJson ignores unknown keys", () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_CAPABILITIES_ROOT, "hai.time.get", "definition.json"), "utf8")
    );
    const def = parseDefinitionJson({ ...raw, evil: 1 });
    expect(def).toEqual(definitionFromCompiledFlat("hai.time.get"));
  });
});
