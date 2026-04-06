import type { MonetaryValue } from "../contracts/kernel";

/**
 * Validates and parses a monetary input into a safe MonetaryValue.
 * Strictly rejects JavaScript 'number' type to prevent floating point errors.
 */
export function parseAmount(input: unknown): MonetaryValue {
  // 1. Fail fast on floating point
  if (typeof input === "number") {
    throw new Error("Invalid monetary type: floats not permitted. Use string ('10.50') or BigInt minor units.");
  }

  // 2. Handle string decimals
  if (typeof input === "string") {
    // Basic regex validation for currency-like strings
    if (!/^-?\d+(\.\d+)?$/.test(input)) {
        throw new Error("Invalid monetary format: string must be numeric decimal.");
    }
    return { kind: "decimal", value: input };
  }

  // 3. Handle BigInt minor units
  if (typeof input === "bigint") {
    return { kind: "minor", value: input };
  }

  // 4. Reject everything else
  throw new Error("Invalid monetary input: must be string or bigint.");
}

