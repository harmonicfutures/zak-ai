import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

function schemaKey(capability: string, version: string): string {
  return `${capability}@${version}`;
}

export function compileSchema(capability: string, version: string, schema: Record<string, unknown>): void {
  const key = schemaKey(capability, version);
  compiled.set(key, ajv.compile(schema));
}

export function dropCompiled(capability: string, version: string): void {
  compiled.delete(schemaKey(capability, version));
}

export function validateAgainstSchema(
  capability: string,
  version: string,
  input: unknown
): { valid: boolean; errors?: ErrorObject[] | null } {
  const validate = compiled.get(schemaKey(capability, version));
  if (!validate) {
    return { valid: false, errors: null };
  }
  const valid = validate(input) as boolean;
  return { valid, errors: valid ? null : validate.errors ?? null };
}

export function ajvErrorsToItems(errors: ErrorObject[] | null | undefined) {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => ({
    path: e.instancePath || e.schemaPath || undefined,
    message: e.message ? e.message : "validation error",
  }));
}
