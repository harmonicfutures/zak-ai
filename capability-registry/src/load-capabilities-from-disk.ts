import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import semver from "semver";
import type { CapabilityCompiledMeta } from "./capability-meta";
import { parseCapabilityCompiledMeta } from "./capability-meta";
import { computeCapabilityDefinitionHash } from "./definition-hash";
import type { CapabilityRegistry } from "./registry";
import type { CapabilityDefinition } from "./types";

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

export interface CapabilityLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Parse `definition.json` into a `CapabilityDefinition`. Only documented registry fields are kept;
 * extra JSON keys are ignored (they must not affect `computeCapabilityDefinitionHash`).
 */
export function parseDefinitionJson(json: unknown): CapabilityDefinition {
  if (!isRecord(json)) {
    throw new Error("definition.json root must be an object");
  }
  const capability = json.capability;
  const version = json.version;
  const adapter = json.adapter;
  const input_schema = json.input_schema;
  if (typeof capability !== "string" || capability.length === 0) {
    throw new Error("definition.json: capability must be a non-empty string");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("definition.json: version must be a non-empty string");
  }
  if (!isRecord(adapter)) {
    throw new Error("definition.json: adapter must be an object");
  }
  const keyRaw = adapter.key;
  const routeRaw = adapter.route;
  if (typeof keyRaw !== "string" || typeof routeRaw !== "string") {
    throw new Error("definition.json: adapter.key and adapter.route must be strings");
  }
  if (!isRecord(input_schema)) {
    throw new Error("definition.json: input_schema must be an object");
  }
  const def: CapabilityDefinition = {
    capability,
    version,
    adapter: { key: keyRaw, route: routeRaw },
    input_schema: input_schema as Record<string, unknown>,
  };
  if (typeof json.description === "string" && json.description.length > 0) {
    def.description = json.description;
  }
  if (Array.isArray(json.tags)) {
    const tags = json.tags.filter((t): t is string => typeof t === "string");
    if (tags.length > 0) def.tags = tags;
  }
  return def;
}

export interface LoadFromDiskOptions {
  /**
   * When true (default), require `definition.hash` and compare to `computeCapabilityDefinitionHash(definition)`.
   * Disable only in isolated tests.
   */
  verifyDefinitionHashFile?: boolean;
  /** Startup diagnostics (id, version, hash). Defaults to console when omitted. */
  logger?: CapabilityLogger;
}

function defaultLogger(): CapabilityLogger {
  return {
    info: (m) => console.error(`[capabilities] ${m}`),
    warn: (m) => console.error(`[capabilities] WARN ${m}`),
  };
}

function readVerifiedDefinitionDir(
  capDir: string,
  verify: boolean,
  log: CapabilityLogger
): { def: CapabilityDefinition; hash: string } {
  const defPath = join(capDir, "definition.json");
  let raw: string;
  try {
    raw = readFileSync(defPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${capDir}: definition.json missing`);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid JSON: ${defPath}`);
  }
  const def = parseDefinitionJson(parsed);
  let hash: string;
  if (verify) {
    const hashPath = join(capDir, "definition.hash");
    let want: string;
    try {
      want = readFileSync(hashPath, "utf8").trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${capDir}: definition.hash missing (required for verified load)`);
      }
      throw e;
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(want)) {
      throw new Error(`${hashPath}: malformed hash line`);
    }
    const got = computeCapabilityDefinitionHash(def);
    if (got !== want) {
      throw new Error(
        `${capDir}: definition hash mismatch (file ${want} vs definition.json → ${got})`
      );
    }
    hash = want;
  } else {
    hash = computeCapabilityDefinitionHash(def);
  }
  log.info(`loaded ${def.capability}@${def.version} ${hash}`);
  return { def, hash };
}

function existsDefJson(dir: string): boolean {
  try {
    return statSync(join(dir, "definition.json")).isFile();
  } catch {
    return false;
  }
}

function readMetaFromDir(capDir: string): CapabilityCompiledMeta {
  const p = join(capDir, "meta.json");
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${capDir}: meta.json missing (required for governed capabilities)`);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid JSON: ${p}`);
  }
  return parseCapabilityCompiledMeta(parsed);
}

export interface CapabilityBundle {
  definition: CapabilityDefinition;
  meta: CapabilityCompiledMeta;
}

/**
 * Load capability definitions + governance `meta.json` from a tree:
 * - **Flat:** `<root>/<capability-id>/definition.json`
 * - **Versioned:** `<root>/<capability-id>/<semver>/definition.json`
 */
export function loadCapabilityBundlesFromDirectory(
  rootDir: string,
  options?: LoadFromDiskOptions
): CapabilityBundle[] {
  const verify = options?.verifyDefinitionHashFile !== false;
  const log = options?.logger ?? defaultLogger();
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`capabilities directory not found: ${rootDir}`);
    }
    throw e;
  }

  const out: CapabilityBundle[] = [];
  const seenKeys = new Set<string>();

  for (const topName of [...names].sort()) {
    const capPath = join(rootDir, topName);
    if (!statSync(capPath).isDirectory()) continue;

    const flatDef = existsDefJson(capPath);
    const versionDirs = [...readdirSync(capPath)]
      .filter((n) => {
        const p = join(capPath, n);
        return statSync(p).isDirectory() && existsDefJson(p);
      })
      .sort();

    if (flatDef && versionDirs.length > 0) {
      throw new Error(
        `${capPath}: cannot have both definition.json and versioned subfolders with definitions`
      );
    }

    if (flatDef) {
      let result: { def: CapabilityDefinition; hash: string };
      try {
        result = readVerifiedDefinitionDir(capPath, verify, log);
      } catch (e) {
        log.warn(`reject ${capPath}: ${(e as Error).message}`);
        throw e;
      }
      const { def } = result;
      if (def.capability !== topName) {
        throw new Error(
          `${capPath}/definition.json: folder name "${topName}" must equal definition.capability "${def.capability}"`
        );
      }
      const k = `${def.capability}@${def.version}`;
      if (seenKeys.has(k)) {
        throw new Error(`duplicate capability registration: ${k}`);
      }
      seenKeys.add(k);
      let meta: CapabilityCompiledMeta;
      try {
        meta = readMetaFromDir(capPath);
      } catch (e) {
        log.warn(`reject ${capPath}: ${(e as Error).message}`);
        throw e;
      }
      out.push({ definition: def, meta });
      continue;
    }

    if (versionDirs.length === 0) continue;

    for (const verDir of versionDirs) {
      if (!semver.valid(verDir)) {
        throw new Error(
          `${join(capPath, verDir)}: version folder "${verDir}" must be valid SemVer when using nested layout`
        );
      }
      const vPath = join(capPath, verDir);
      let result: { def: CapabilityDefinition; hash: string };
      try {
        result = readVerifiedDefinitionDir(vPath, verify, log);
      } catch (e) {
        log.warn(`reject ${vPath}: ${(e as Error).message}`);
        throw e;
      }
      const { def } = result;
      if (def.capability !== topName) {
        throw new Error(
          `${vPath}/definition.json: parent folder must be definition.capability (expected "${def.capability}", got "${topName}")`
        );
      }
      if (def.version !== verDir) {
        throw new Error(
          `${vPath}/definition.json: folder "${verDir}" must equal definition.version "${def.version}"`
        );
      }
      const k = `${def.capability}@${def.version}`;
      if (seenKeys.has(k)) {
        throw new Error(`duplicate capability registration: ${k}`);
      }
      seenKeys.add(k);
      let meta: CapabilityCompiledMeta;
      try {
        meta = readMetaFromDir(vPath);
      } catch (e) {
        log.warn(`reject ${vPath}: ${(e as Error).message}`);
        throw e;
      }
      out.push({ definition: def, meta });
    }
  }

  return out;
}

export function loadDefinitionsFromCapabilitiesDirectory(
  rootDir: string,
  options?: LoadFromDiskOptions
): CapabilityDefinition[] {
  return loadCapabilityBundlesFromDirectory(rootDir, options).map((b) => b.definition);
}

export function registerCapabilitiesFromDirectory(
  registry: CapabilityRegistry,
  rootDir: string,
  options?: LoadFromDiskOptions
): void {
  for (const { definition, meta } of loadCapabilityBundlesFromDirectory(rootDir, options)) {
    registry.registerCapability(definition);
    registry.registerCapabilityMeta(definition.capability, definition.version, meta);
  }
}

/** Resolved capabilities tree root (for hosts): `ZAK_CAPABILITIES_DIR` or `<cwd>/capabilities`. */
export function resolveDefaultCapabilitiesRoot(): string {
  if (process.env.ZAK_CAPABILITIES_DIR && process.env.ZAK_CAPABILITIES_DIR.length > 0) {
    return resolve(process.env.ZAK_CAPABILITIES_DIR);
  }
  return resolve(process.cwd(), "capabilities");
}
