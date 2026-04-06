import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeCapabilityDefinitionHash } from "@zak/capability-registry";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { worksheetToCapabilityDefinition } from "./compile-def";
import { generateTestSpec } from "./gen-test";
import { buildMeta } from "./meta";
import type { JsonObject } from "./normalize";
import { normalizeAdapterField, normalizeCapabilityId, normalizeWorksheetTree } from "./normalize";
import { stringifySortedPretty } from "./pretty-json";
import { validateWorksheet } from "./validate";

export interface CompileOptions {
  /** Parent directory of per-capability folders. */
  outBase: string;
  /**
   * When true, emit to `<outBase>/<capability>/<version>/` (multi-version capabilities).
   * When false, emit to `<outBase>/<capability>/` (single-version).
   */
  nestedVersionLayout?: boolean;
}

function applyNamingNorm(root: JsonObject): void {
  if (typeof root.capability === "string") {
    root.capability = normalizeCapabilityId(root.capability);
  }
  const ad = root.adapter;
  if (ad !== null && typeof ad === "object" && !Array.isArray(ad)) {
    const a = ad as JsonObject;
    if (typeof a.key === "string") a.key = normalizeAdapterField(a.key);
    if (typeof a.route === "string") a.route = normalizeAdapterField(a.route);
  }
}

export function parseWorksheetYaml(text: string): unknown {
  const raw = parseYaml(text);
  const tree = normalizeWorksheetTree(raw) as JsonObject;
  applyNamingNorm(tree);
  return tree;
}

export function compileWorksheetFile(worksheetPath: string, options: CompileOptions): void {
  const text = readFileSync(worksheetPath, "utf8");
  const parsed = parseWorksheetYaml(text);
  const validated = validateWorksheet(parsed);
  if (!validated.ok) {
    throw new Error(`worksheet invalid:\n${validated.errors.join("\n")}`);
  }
  const ws = validated.ws;
  const outDir = options.nestedVersionLayout
    ? join(options.outBase, ws.capability, ws.version)
    : join(options.outBase, ws.capability);
  mkdirSync(outDir, { recursive: true });

  const definition = worksheetToCapabilityDefinition(ws);
  const hash = computeCapabilityDefinitionHash(definition);
  const meta = buildMeta(ws);

  writeFileSync(join(outDir, "worksheet.normalized.yaml"), stringifyYaml(parsed as object));
  writeFileSync(join(outDir, "definition.json"), stringifySortedPretty(definition));
  writeFileSync(join(outDir, "definition.hash"), `${hash}\n`);
  writeFileSync(join(outDir, "meta.json"), stringifySortedPretty(meta));

  const fixture: Record<string, unknown> = { input: ws.golden!.input };
  if (ws.golden!.output !== undefined) {
    fixture.output = ws.golden!.output;
  }
  writeFileSync(join(outDir, "test.fixture.json"), stringifySortedPretty(fixture));

  writeFileSync(join(outDir, "test.spec.ts"), generateTestSpec(ws));
}

function verifyOneCapabilityDir(dir: string, label: string): void {
  const defPath = join(dir, "definition.json");
  const hashPath = join(dir, "definition.hash");
  const definition = JSON.parse(readFileSync(defPath, "utf8"));
  const want = readFileSync(hashPath, "utf8").trim();
  const got = computeCapabilityDefinitionHash(definition as import("@zak/capability-registry").CapabilityDefinition);
  if (got !== want) {
    throw new Error(`${label}: definition hash mismatch (disk ${want} vs computed ${got})`);
  }
}

/** Verify every definition.json under flat or `<cap>/<semver>/` layout. */
export function verifyCompiledCapabilities(outBase: string): void {
  const names = readdirSync(outBase);
  for (const name of names) {
    const capDir = join(outBase, name);
    if (!statSync(capDir).isDirectory()) continue;

    const flatDef = join(capDir, "definition.json");
    let flatExists = false;
    try {
      flatExists = statSync(flatDef).isFile();
    } catch {
      flatExists = false;
    }

    if (flatExists) {
      verifyOneCapabilityDir(capDir, name);
      continue;
    }

    for (const ver of [...readdirSync(capDir)].sort()) {
      const vDir = join(capDir, ver);
      if (!statSync(vDir).isDirectory()) continue;
      const vDef = join(vDir, "definition.json");
      try {
        if (!statSync(vDef).isFile()) continue;
      } catch {
        continue;
      }
      verifyOneCapabilityDir(vDir, `${name}@${ver}`);
    }
  }
}
