/**
 * Thin test harness only: browser → API → model → registry gate.
 * Not a product surface; no membrane authority here.
 *
 * LLM:
 *   - Set OPENROUTER_API_KEY + optional OPENROUTER_MODEL (default openrouter/free) for testing.
 *   - Or OPENAI_API_KEY + OPENAI_MODEL when OPENROUTER_API_KEY is unset.
 *   - Optional .env: repo root (ZAKAI/.env) or draft-test-harness/.env (harness wins on duplicate keys).
 *
 *   cd ../capability-registry && npm run build
 *   cd ../draft-test-harness && npm install && npm start
 *
 * Open http://localhost:3000/
 */

import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import {
  createRegistryWithBuiltins,
  prepareExecutionRequest,
} from "../capability-registry/dist/index.js";
import {
  AGENT_DECISION_INSTRUCTIONS,
  runToolEcho,
  validateDecision,
} from "./lib/agent-loop.mjs";
import { createHarnessLlm, hasLlmCredentials, llmJsonObject, llmText } from "./lib/llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

const llm = createHarnessLlm();
const registry = createRegistryWithBuiltins();
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

app.post("/generate", async (req, res) => {
  try {
    if (!hasLlmCredentials(llm)) {
      return res.status(500).json({
        ok: false,
        stage: "config",
        error: llm.useOpenRouter
          ? "OPENROUTER_API_KEY is not set"
          : "OPENAI_API_KEY is not set",
      });
    }

    const { prompt } = req.body;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, stage: "request", error: "prompt_required" });
    }

    const text = await llmJsonObject(llm, prompt);
    if (!text) {
      return res.json({
        ok: false,
        stage: "model",
        error: "empty_model_output",
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

/**
 * Execution sandbox (pre-ZAK): prompt → decision JSON → validate → tool or direct → final.
 * Maps loosely to: decision ≈ admission intent, tool ≈ capability, validation ≈ fail-closed.
 */
app.post("/agent/run", async (req, res) => {
  const trace = [];

  try {
    if (!hasLlmCredentials(llm)) {
      return res.status(500).json({
        ok: false,
        stage: "config",
        error: llm.useOpenRouter
          ? "OPENROUTER_API_KEY is not set"
          : "OPENAI_API_KEY is not set",
        trace,
      });
    }

    const { prompt } = req.body;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, stage: "request", error: "prompt_required", trace });
    }

    const decisionInput = `${AGENT_DECISION_INSTRUCTIONS}\n\nUser request:\n${prompt.trim()}`;
    const decisionText = await llmJsonObject(llm, decisionInput);
    trace.push({
      step: "decision_raw",
      ok: Boolean(decisionText),
      model: llm.model,
      provider: llm.useOpenRouter ? "openrouter" : "openai",
    });

    if (!decisionText) {
      return res.json({
        ok: false,
        stage: "decision_empty",
        error: "model_returned_no_text",
        trace,
      });
    }

    let decisionParsed;
    try {
      decisionParsed = JSON.parse(decisionText);
    } catch {
      return res.json({
        ok: false,
        stage: "decision_parse",
        error: "invalid_json",
        raw: decisionText,
        trace,
      });
    }

    const vErr = validateDecision(decisionParsed);
    trace.push({ step: "decision_validated", ok: vErr === null, decision: decisionParsed });
    if (vErr !== null) {
      return res.json({
        ok: false,
        stage: "decision_rejected",
        error: vErr,
        decision: decisionParsed,
        trace,
      });
    }

    if (decisionParsed.decision === "respond_directly") {
      trace.push({
        step: "final",
        path: "respond_directly",
        text: decisionParsed.message,
      });
      return res.json({
        ok: true,
        stage: "done",
        final: decisionParsed.message,
        trace,
        raw: { decision: decisionParsed, tool_result: null },
      });
    }

    const toolResult = runToolEcho(decisionParsed.arguments);
    trace.push({ step: "tool", ...toolResult });

    const finalizeInput = `The user asked:\n${prompt.trim()}\n\nThe echo tool was invoked and returned this JSON:\n${JSON.stringify(
      toolResult.output
    )}\n\nWrite a single short plain-text reply to the user that incorporates this result. No JSON, no bullet meta-commentary.`;
    const finalRaw = await llmText(llm, finalizeInput);
    const finalText = finalRaw?.trim() ?? "";
    trace.push({ step: "finalize_model", ok: finalText.length > 0 });

    if (!finalText) {
      return res.json({
        ok: false,
        stage: "finalize_empty",
        error: "model_returned_no_final_text",
        decision: decisionParsed,
        tool_result: toolResult,
        trace,
      });
    }

    return res.json({
      ok: true,
      stage: "done",
      final: finalText,
      trace,
      raw: { decision: decisionParsed, tool_result: toolResult },
    });
  } catch (err) {
    trace.push({ step: "server_error", error: err?.message ?? String(err) });
    return res.status(500).json({
      ok: false,
      stage: "server",
      error: err?.message ?? String(err),
      trace,
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
  console.log(
    "LLM provider=%s model=%s ZAK_CONSTITUTION_ID=%s",
    llm.useOpenRouter ? "openrouter" : "openai",
    llm.model,
    CONSTITUTION_ID
  );
});
