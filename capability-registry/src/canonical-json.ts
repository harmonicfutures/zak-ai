import { sha256Hex } from "./sha256";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256HexCanonical(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function sha256TaggedCanonical(value: unknown): string {
  return `sha256:${sha256HexCanonical(value)}`;
}
