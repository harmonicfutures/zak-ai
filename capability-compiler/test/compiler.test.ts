import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeCapabilityDefinitionHash, parseDefinitionJson } from "@zak/capability-registry";
import { compileWorksheetFile, parseWorksheetYaml, verifyCompiledCapabilities } from "../src/emit";
import { validateWorksheet } from "../src/validate";
import { worksheetToCapabilityDefinition } from "../src/compile-def";

const root = resolve(__dirname, "..");
const caps = resolve(root, "..", "capabilities");

function timeGetFromDisk() {
  return parseDefinitionJson(
    JSON.parse(readFileSync(resolve(caps, "hai.time.get", "definition.json"), "utf8"))
  );
}

describe("capability-compiler", () => {
  it("hai.time.get worksheet validates and matches committed definition.json", () => {
    const text = readFileSync(resolve(caps, "hai.time.get", "worksheet.yaml"), "utf8");
    const parsed = parseWorksheetYaml(text);
    const v = validateWorksheet(parsed);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const def = worksheetToCapabilityDefinition(v.ws);
    expect(def).toEqual(timeGetFromDisk());
    expect(computeCapabilityDefinitionHash(def)).toBe(computeCapabilityDefinitionHash(timeGetFromDisk()));
  });

  it("verify passes for committed capabilities tree", () => {
    verifyCompiledCapabilities(caps);
  });

  it("compile is deterministic for hai.time.get", () => {
    compileWorksheetFile(resolve(caps, "hai.time.get", "worksheet.yaml"), { outBase: caps });
    const hash = readFileSync(resolve(caps, "hai.time.get", "definition.hash"), "utf8").trim();
    expect(hash).toBe(computeCapabilityDefinitionHash(timeGetFromDisk()));
  });
});
