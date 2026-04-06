/**
 * OpenAI → draft JSON → prepareExecutionRequest (real gate).
 *
 * Requires:
 *   export OPENAI_API_KEY="..."
 * Optional:
 *   export OPENAI_MODEL="gpt-4o"   (or your Responses-supported model)
 *   export ZAK_CONSTITUTION_ID="zak-default"
 *
 * From repo: capability-registry must be built (dist/).
 *   cd ../../ && npm run build && cd examples/openai-draft-pipeline && npm install && npm start
 */

import OpenAI from "openai";
import { createRegistryWithBuiltins, prepareExecutionRequest } from "../../dist/index.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";
const CONSTITUTION_ID = process.env.ZAK_CONSTITUTION_ID ?? "zak-default";

const SYSTEM_PROMPT = `You are generating a capability request draft.

Output ONLY JSON (no markdown, no prose).

Top-level object must have exactly two keys: "capability" and "input". No other top-level keys.

Schema shape:
{
  "capability": string,
  "input": object
}

Rules:
- capability must be exactly "hai.particle.update"
- input must satisfy: particle_id non-empty string, attributes object; you may set attributes.hue as a number between 0 and 1 inclusive
- no extra top-level keys beyond capability and input`;

function strictDraftShape(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parsed JSON must be a plain object");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !("capability" in parsed) || !("input" in parsed)) {
    throw new Error('model output must be exactly { "capability", "input" }');
  }
  if (typeof parsed.capability !== "string") {
    throw new Error("capability must be a string");
  }
  if (parsed.input === null || typeof parsed.input !== "object" || Array.isArray(parsed.input)) {
    throw new Error("input must be an object");
  }
  return parsed;
}

async function generateDraft() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.responses.create({
    model: MODEL,
    input: SYSTEM_PROMPT,
    text: {
      format: { type: "json_object" },
    },
  });

  const raw =
    typeof response.output_text === "string" && response.output_text.length > 0
      ? response.output_text
      : null;

  if (!raw) {
    throw new Error("empty model output (no output_text)");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON from model: ${e?.message ?? e}`);
  }

  return strictDraftShape(parsed);
}

const registry = createRegistryWithBuiltins();

try {
  const draftPayload = await generateDraft();
  console.error("[model raw draft]", JSON.stringify(draftPayload));

  const draft = {
    capability: draftPayload.capability,
    input: draftPayload.input,
    context: { constitution_id: CONSTITUTION_ID },
  };

  const prep = prepareExecutionRequest(registry, draft);

  if (prep.ok) {
    console.log(JSON.stringify({ ok: true, request: prep.request, adapter: prep.adapter }, null, 2));
    process.exit(0);
  }

  console.log(JSON.stringify({ ok: false, errors: prep.errors }, null, 2));
  process.exit(1);
} catch (err) {
  console.error(JSON.stringify({ ok: false, errors: [{ message: String(err?.message ?? err) }] }));
  process.exit(1);
}
