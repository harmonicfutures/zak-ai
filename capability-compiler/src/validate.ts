import Ajv from "ajv";
import addFormats from "ajv-formats";
import semver from "semver";
import type { JsonObject } from "./normalize";
import { coerceOutputSchema } from "./output-schema";

const CAPABILITY_RE = /^(hai|zak)\.[a-z][a-z0-9_.]*$/;
const ADAPTER_KEY_RE = /^[a-z][a-z0-9-]*$/;
const ROUTE_RE = /^[a-z][a-z0-9_.]*$/;

const TOP_KEYS = new Set([
  "capability",
  "version",
  "adapter",
  "execution_class",
  "authority_requirements",
  "input_schema",
  "output_schema",
  "golden",
  "description",
  "tags",
  "side_effect_tier",
  "idempotency",
  "replay_behavior",
  "async_model",
  "job_id_field",
  "partial_receipt",
]);

type ExecClass = "A" | "B" | "C";
type Authority = "none" | "standard" | "elevated" | "continuous_resonance_required";

export interface ValidatedWorksheet {
  capability: string;
  version: string;
  adapter: { key: string; route: string };
  execution_class: ExecClass;
  authority_requirements: Authority;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  golden: { input: Record<string, unknown>; output?: unknown };
  description?: string;
  tags?: string[];
  side_effect_tier?: "low" | "medium" | "irreversible";
  idempotency?: "none" | "keyed" | "inherent";
  replay_behavior?: "blocked" | "allowed_same_key" | "allowed_read_only_subset";
  async_model?: "poll" | "callback" | "poll_or_callback";
  job_id_field?: string;
  partial_receipt?: boolean;
}

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateWorksheet(raw: unknown): { ok: true; ws: ValidatedWorksheet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["worksheet root must be a mapping"] };
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) errors.push(`unknown top-level key: "${k}"`);
  }
  if (errors.length) return { ok: false, errors };

  const capability = raw.capability;
  const version = raw.version;
  const adapter = raw.adapter;
  const execution_class = raw.execution_class;
  const authority_requirements = raw.authority_requirements;
  const input_schema = raw.input_schema;
  const output_schema = raw.output_schema;

  if (typeof capability !== "string" || !CAPABILITY_RE.test(capability)) {
    errors.push('capability must match ^(hai|zak).[a-z][a-z0-9_.]*$ (lowercase segments after prefix)');
  }
  if (typeof version !== "string" || !semver.valid(version)) {
    errors.push("version must be a valid SemVer string");
  }
  if (!isObject(adapter)) {
    errors.push("adapter must be a mapping with key and route");
  } else {
    const key = adapter.key;
    const route = adapter.route;
    if (typeof key !== "string" || !ADAPTER_KEY_RE.test(key)) {
      errors.push('adapter.key must match ^[a-z][a-z0-9-]*$');
    }
    if (typeof route !== "string" || !ROUTE_RE.test(route)) {
      errors.push('adapter.route must match ^[a-z][a-z0-9_.]*$');
    }
  }
  if (execution_class !== "A" && execution_class !== "B" && execution_class !== "C") {
    errors.push("execution_class must be A, B, or C");
  }
  const auth = authority_requirements;
  if (
    auth !== "none" &&
    auth !== "standard" &&
    auth !== "elevated" &&
    auth !== "continuous_resonance_required"
  ) {
    errors.push("authority_requirements must be none|standard|elevated|continuous_resonance_required");
  }
  if (!isObject(input_schema)) {
    errors.push("input_schema must be a JSON Schema object");
  }
  if (output_schema === undefined || output_schema === null) {
    errors.push("output_schema is required (JSON Schema object or shorthand field map)");
  }
  if (raw.golden === undefined || raw.golden === null) {
    errors.push("golden is required (minimum: input — compiler emits hash + schema + fixture tests)");
  }

  if (execution_class === "B") {
    const t = raw.side_effect_tier;
    if (t !== "low" && t !== "medium" && t !== "irreversible") {
      errors.push("Class B: side_effect_tier must be low|medium|irreversible");
    }
    const id = raw.idempotency;
    if (id !== "none" && id !== "keyed" && id !== "inherent") {
      errors.push("Class B: idempotency must be none|keyed|inherent");
    }
    const rb = raw.replay_behavior;
    if (rb !== "blocked" && rb !== "allowed_same_key" && rb !== "allowed_read_only_subset") {
      errors.push("Class B: replay_behavior must be blocked|allowed_same_key|allowed_read_only_subset");
    }
  }

  if (execution_class === "C") {
    const am = raw.async_model;
    if (am !== "poll" && am !== "callback" && am !== "poll_or_callback") {
      errors.push("Class C: async_model must be poll|callback|poll_or_callback");
    }
    if (typeof raw.job_id_field !== "string" || raw.job_id_field.trim().length === 0) {
      errors.push("Class C: job_id_field must be a non-empty string");
    }
    if (raw.partial_receipt !== true && raw.partial_receipt !== false) {
      errors.push("Class C: partial_receipt must be boolean");
    }
  }

  if (execution_class === "A") {
    if (raw.side_effect_tier !== undefined) errors.push("Class A: must not set side_effect_tier");
    if (raw.idempotency !== undefined) errors.push("Class A: must not set idempotency");
    if (raw.replay_behavior !== undefined) errors.push("Class A: must not set replay_behavior");
    if (raw.async_model !== undefined) errors.push("Class A: must not set async_model");
    if (raw.job_id_field !== undefined) errors.push("Class A: must not set job_id_field");
    if (raw.partial_receipt !== undefined) errors.push("Class A: must not set partial_receipt");
  }

  if (execution_class === "B") {
    if (raw.async_model !== undefined) errors.push("Class B: must not set async fields (use Class C as primary if async)");
    if (raw.job_id_field !== undefined) errors.push("Class B: must not set job_id_field");
    if (raw.partial_receipt !== undefined) errors.push("Class B: must not set partial_receipt");
  }

  if (execution_class === "C") {
    if (raw.side_effect_tier !== undefined) errors.push("Class C: must not set Class B mutating fields (split capability or extend compiler policy)");
    if (raw.idempotency !== undefined) errors.push("Class C: must not set idempotency");
    if (raw.replay_behavior !== undefined) errors.push("Class C: must not set replay_behavior");
  }

  if (errors.length) return { ok: false, errors };

  let coercedOutput: Record<string, unknown>;
  try {
    coercedOutput = coerceOutputSchema(output_schema);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }

  const ajvMeta = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajvMeta);
  try {
    ajvMeta.compile(coercedOutput);
  } catch (e) {
    return { ok: false, errors: [`output_schema invalid: ${(e as Error).message}`] };
  }

  const ajvIn = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajvIn);
  try {
    ajvIn.compile(input_schema as object);
  } catch (e) {
    return { ok: false, errors: [`input_schema invalid: ${(e as Error).message}`] };
  }

  let golden: ValidatedWorksheet["golden"] | undefined;
  if (raw.golden !== undefined && raw.golden !== null) {
    if (!isObject(raw.golden)) {
      errors.push("golden must be a mapping with input (and optional output)");
    } else if (!isObject(raw.golden.input)) {
      errors.push("golden.input must be an object");
    } else {
      const validateIn = ajvIn.compile(input_schema as object);
      const gi = raw.golden.input as Record<string, unknown>;
      const inputOk = validateIn(gi);
      if (!inputOk) {
        errors.push(`golden.input fails input_schema: ${ajvIn.errorsText(validateIn.errors)}`);
      }
      let outputOk = true;
      if (raw.golden.output !== undefined && raw.golden.output !== null) {
        const validateOut = ajvMeta.compile(coercedOutput);
        outputOk = Boolean(validateOut(raw.golden.output));
        if (!outputOk) {
          errors.push(`golden.output fails output_schema: ${ajvMeta.errorsText(validateOut.errors)}`);
        }
      }
      if (inputOk && outputOk) {
        golden = {
          input: gi,
          output: raw.golden.output === null ? undefined : raw.golden.output,
        };
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  if (golden === undefined) {
    return { ok: false, errors: ["golden must be a valid mapping with input"] };
  }

  let description: string | undefined;
  if (typeof raw.description === "string") {
    const d = raw.description.trim();
    if (d.length > 0) description = d;
  }

  let tags: string[] | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) {
      return { ok: false, errors: ["tags must be an array of strings"] };
    }
    const tgs = [...new Set(raw.tags.map((t: string) => t.trim()).filter(Boolean))].sort();
    if (tgs.length) tags = tgs;
  }

  const ws: ValidatedWorksheet = {
    capability: capability as string,
    version: version as string,
    adapter: {
      key: (adapter as JsonObject).key as string,
      route: (adapter as JsonObject).route as string,
    },
    execution_class: execution_class as ExecClass,
    authority_requirements: auth as Authority,
    input_schema: input_schema as Record<string, unknown>,
    output_schema: coercedOutput,
    golden,
    description,
    tags,
  };
  if (execution_class === "B") {
    ws.side_effect_tier = raw.side_effect_tier as ValidatedWorksheet["side_effect_tier"];
    ws.idempotency = raw.idempotency as ValidatedWorksheet["idempotency"];
    ws.replay_behavior = raw.replay_behavior as ValidatedWorksheet["replay_behavior"];
  }
  if (execution_class === "C") {
    ws.async_model = raw.async_model as ValidatedWorksheet["async_model"];
    ws.job_id_field = (raw.job_id_field as string).trim();
    ws.partial_receipt = raw.partial_receipt as boolean;
  }

  return { ok: true, ws };
}
