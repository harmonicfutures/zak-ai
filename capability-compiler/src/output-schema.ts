import type { JsonObject } from "./normalize";

/** If shorthand (map of name → type string), convert to JSON Schema draft-07 object. */
export function coerceOutputSchema(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("output_schema must be a mapping or JSON Schema object");
  }
  const o = raw as JsonObject;
  if (typeof o.type === "string") {
    return o as Record<string, unknown>;
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string") {
      throw new Error(`output_schema field "${k}" must be a type string or use full JSON Schema on output_schema root`);
    }
    const t = v.trim().toLowerCase();
    if (t === "string") props[k] = { type: "string" };
    else if (t === "number") props[k] = { type: "number" };
    else if (t === "integer") props[k] = { type: "integer" };
    else if (t === "boolean") props[k] = { type: "boolean" };
    else if (t === "object") props[k] = { type: "object" };
    else if (t === "array") props[k] = { type: "array" };
    else
      throw new Error(
        `output_schema shorthand "${k}": unknown type "${v}" (use string|number|integer|boolean|object|array)`
      );
  }
  return {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
}
