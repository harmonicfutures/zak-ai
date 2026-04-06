/**
 * Thin test harness only: browser → API → model → registry gate.
 * Not a product surface; no membrane authority here.
 *
 *   export OPENAI_API_KEY="..."
 *   optional: OPENAI_MODEL, ZAK_CONSTITUTION_ID
 *
 *   cd ../capability-registry && npm run build
 *   cd ../draft-test-harness && npm install && npm start
 *
 * Open http://localhost:3000/
 */

import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

import {
  createRegistryWithBuiltins,
  prepareExecutionRequest,
} from "../capability-registry/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const registry = createRegistryWithBuiltins();
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";
const CONSTITUTION_ID = process.env.ZAK_CONSTITUTION_ID ?? "zak-default";

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
  if (parsed.input === null || typeof parsed.input !== "object" || Array.isArray(parsed)) {
    throw new Error("input must be an object");
  }
  return parsed;
}

function extractResponseText(response) {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  const first = response.output?.[0];
  const content = first?.content?.[0];
  if (content?.text != null && typeof content.text === "string") {
    return content.text;
  }
  return null;
}

app.post("/generate", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        stage: "config",
        error: "OPENAI_API_KEY is not set",
      });
    }

    const { prompt } = req.body;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, stage: "request", error: "prompt_required" });
    }

    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
      text: {
        format: { type: "json_object" },
      },
    });

    const text = extractResponseText(response);
    if (!text) {
      return res.json({
        ok: false,
        stage: "model",
        error: "empty_model_output",
        raw: response,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.json({ ok: false, stage: "parse", error: "invalid_json", raw: text });
    }

    let shaped;
    try {
      shaped = strictDraftShape(parsed);
    } catch (shapeErr) {
      return res.json({
        ok: false,
        stage: "shape",
        error: shapeErr?.message ?? String(shapeErr),
        draft: parsed,
      });
    }

    const prep = prepareExecutionRequest(registry, {
      capability: shaped.capability,
      input: shaped.input,
      context: { constitution_id: CONSTITUTION_ID },
    });

    if (!prep.ok) {
      return res.json({
        ok: false,
        stage: "validation",
        errors: prep.errors,
        draft: shaped,
      });
    }

    return res.json({
      ok: true,
      stage: "validated",
      request: prep.request,
      adapter: prep.adapter,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      stage: "server",
      error: err?.message ?? String(err),
    });
  }
});

/** Optional: membrane is TCP/register/admit — not wired by default. */
app.post("/admit", (req, res) => {
  res.status(501).json({
    ok: false,
    stage: "admit",
    error: "not_wired",
    detail:
      "Membrane uses register + admit + execute over the engine proxy; wire a client or set a gateway. This harness stops at prepareExecutionRequest.",
  });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Draft test harness: http://localhost:${PORT}`);
  console.log("OPENAI_MODEL=%s ZAK_CONSTITUTION_ID=%s", MODEL, CONSTITUTION_ID);
});
