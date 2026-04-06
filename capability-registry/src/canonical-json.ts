import { createHash } from "crypto";

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
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function sha256TaggedCanonical(value: unknown): string {
  return `sha256:${sha256HexCanonical(value)}`;
}
