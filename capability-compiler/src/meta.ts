import { COMPILER_VERSION, TEMPLATE_VERSION } from "./constants";
import type { ValidatedWorksheet } from "./validate";
import { sortKeysDeep } from "./normalize";

export function buildMeta(ws: ValidatedWorksheet): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    generated_by: "@zak/capability-compiler",
    compiler_version: COMPILER_VERSION,
    template_version: TEMPLATE_VERSION,
    execution_class: ws.execution_class,
    authority_requirements: ws.authority_requirements,
    output_schema: ws.output_schema,
  };
  if (ws.side_effect_tier !== undefined) {
    meta.side_effect_tier = ws.side_effect_tier;
    meta.idempotency = ws.idempotency;
    meta.replay_behavior = ws.replay_behavior;
  }
  if (ws.async_model !== undefined) {
    meta.async_model = ws.async_model;
    meta.job_id_field = ws.job_id_field;
    meta.partial_receipt = ws.partial_receipt;
  }
  return sortKeysDeep(meta) as Record<string, unknown>;
}
