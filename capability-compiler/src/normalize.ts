export type JsonObject = Record<string, unknown>;

function trimDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(trimDeep);
  }
  const o = value as JsonObject;
  const out: JsonObject = {};
  for (const k of Object.keys(o).sort()) {
    out[k] = trimDeep(o[k]) as unknown;
  }
  return out;
}

/** Normalize capability id: lowercase, no surrounding whitespace. */
export function normalizeCapabilityId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Adapter key/route: trim only; keep casing as given (routes are usually lower). */
export function normalizeAdapterField(raw: string): string {
  return raw.trim();
}

/**
 * Deterministic key order at every object level (for YAML / meta snapshots).
 * Does not change array order.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const o = value as JsonObject;
  const out: JsonObject = {};
  for (const k of Object.keys(o).sort()) {
    out[k] = sortKeysDeep(o[k]) as unknown;
  }
  return out;
}

export function normalizeWorksheetTree(value: unknown): unknown {
  return sortKeysDeep(trimDeep(value));
}
