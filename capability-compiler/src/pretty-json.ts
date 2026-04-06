import type { JsonObject } from "./normalize";

export function stringifySortedPretty(value: unknown, space = 2): string {
  return `${JSON.stringify(sortKeysDeep(value), null, space)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
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
