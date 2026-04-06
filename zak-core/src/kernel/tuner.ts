import { Sigil } from "./validator";
import { createHash } from "crypto";

// --- WRITE CONTRACT ---

export interface SigilWriteProfile {
  id: string;

  // Explicitly allowed write paths (dot notation)
  allow_write_paths: Set<string>;

  // Delta limits per path
  delta_limits: {
    [path: string]: {
      max_step: number;
      hard_min?: number;
      hard_max?: number;
    };
  };

  // Authority model (future-proofed)
  required_signature: "self" | "system" | "authority";
}

// --- TUNER ---

export function applyTuning(
  currentSigil: Sigil,
  proposedDelta: Record<string, number>,
  contract: SigilWriteProfile
): Sigil {

  // Clone for immutability
  const nextSigil: Sigil = structuredClone(currentSigil);
  const nextVersion = currentSigil.meta.version + 1;

  for (const [path, delta] of Object.entries(proposedDelta)) {

    // 1. Path must be explicitly writable
    if (!contract.allow_write_paths.has(path)) {
      continue;
    }

    const limits = contract.delta_limits[path];
    if (!limits) {
      continue;
    }

    // 2. Clamp delta step
    const step = Math.max(
      -limits.max_step,
      Math.min(delta, limits.max_step)
    );

    const currentValue = getByPath(nextSigil.body, path);
    if (typeof currentValue !== "number") {
      continue;
    }

    let newValue = currentValue + step;

    // 3. Enforce hard bounds
    if (limits.hard_min !== undefined) {
      newValue = Math.max(newValue, limits.hard_min);
    }
    if (limits.hard_max !== undefined) {
      newValue = Math.min(newValue, limits.hard_max);
    }

    setByPath(nextSigil.body, path, newValue);
  }

  // 4. Reseal
  nextSigil.meta.version = nextVersion;
  nextSigil.meta.created_at = Date.now();
  nextSigil.meta.content_hash = computeCanonicalHash(nextSigil.body);

  return nextSigil;
}

// --- HELPERS ---

function getByPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setByPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(v => canonicalStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(
    k => `"${k}":${canonicalStringify(obj[k])}`
  ).join(",") + "}";
}

function computeCanonicalHash(body: any): string {
  const json = canonicalStringify(body);
  return createHash("sha256").update(json).digest("hex");
}

