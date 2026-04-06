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
 *   cd ../capability-compiler && npm run build && node dist/cli.js verify ../capabilities
 *   cd ../draft-test-harness && npm install && npm start
 *
 * Optional: ZAK_ADMISSION_AUTHORITY=none|standard|elevated|continuous_resonance (host trust boundary).
 *
 * Open http://localhost:3000/
 */

import dotenv from "dotenv";
import express from "express";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import registryPkg from "../capability-registry/dist/index.js";
const {
  assertGovernanceStartupInvariants,
  collectGovernanceStartupInvariants,
  createFileGovernanceRuntime,
  createRegistryFromCompiledCapabilities,
  executeGovernedCapability,
  getGovernanceHealthStatus,
  resolveAuthorityContext,
} = registryPkg;
import {
  AGENT_DECISION_INSTRUCTIONS,
  runToolEcho,
  validateDecision,
} from "./lib/agent-loop.mjs";
import {
  classifyGeneratePrompt,
  classifyIntent,
  isTimeQuestionPrompt,
} from "./lib/intent-classify.mjs";
import {
  buildExecutionFailureBody,
  buildExecutionSuccessBody,
} from "./lib/governed-response.mjs";
import { createHarnessLlm, hasLlmCredentials, llmJsonObject, llmText } from "./lib/llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

const llm = createHarnessLlm();

function resolveCapabilitiesRoot() {
  if (process.env.ZAK_CAPABILITIES_DIR) {
    return path.resolve(process.env.ZAK_CAPABILITIES_DIR);
  }
  return path.join(__dirname, "..", "capabilities");
}

const capabilitiesRoot = resolveCapabilitiesRoot();
if (!existsSync(capabilitiesRoot)) {
  throw new Error(
    `[harness] Compiled capabilities missing: ${capabilitiesRoot}. Run cap-compile or set ZAK_CAPABILITIES_DIR.`
  );
}

const registry = createRegistryFromCompiledCapabilities(capabilitiesRoot);
const governanceRoot = process.env.ZAK_GOVERNANCE_DIR
  ? path.resolve(process.env.ZAK_GOVERNANCE_DIR)
  : path.join(__dirname, ".governance");
const governanceRuntime = createFileGovernanceRuntime({
  rootDir: governanceRoot,
  environmentId: process.env.ZAK_ENVIRONMENT_ID ?? "draft-test-harness",
  runtimeId: process.env.ZAK_RUNTIME_ID ?? "draft-test-harness",
});
assertGovernanceStartupInvariants(registry, governanceRuntime);
const CONSTITUTION_ID = process.env.ZAK_CONSTITUTION_ID ?? "zak-default";

/** Trusted host admission tier (not model-controlled). */
function resolveAdmissionAuthorityLevel() {
  const v = process.env.ZAK_ADMISSION_AUTHORITY;
  if (v === "standard" || v === "elevated" || v === "continuous_resonance") return v;
  return "none";
}

function resolveAuthorityContextForRequest(req) {
  const subjectId =
    req.ip && typeof req.ip === "string" && req.ip.length > 0 ? req.ip : "draft-test-user";
  return resolveAuthorityContext(resolveAdmissionAuthorityLevel(), {
    source: "draft-test-harness-env",
    evaluated_at: governanceRuntime.now(),
    session_id: req.get("x-session-id") || "draft-test-session",
    subject_id: subjectId,
  });
}

/** Browser sends IANA zone (e.g. America/Chicago). Reject garbage / oversize. */
function sanitizeClientTimezone(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 120) return null;
  if (!/^[A-Za-z0-9_\/+\-]+$/.test(s)) return null;
  return s;
}

/** Harness-only: no membrane. Satisfy hai.time.get so the UI shows real wall time. */
function harnessSimulateTimeGet(input) {
  const raw =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? /** @type {Record<string, unknown>} */ (input).timezone
      : undefined;
  const zone = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "UTC";
  const now = new Date();
  try {
    const localDisplay = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(now);
    return {
      timezone: zone,
      utc_iso: now.toISOString(),
      local_display: localDisplay,
    };
  } catch (err) {
    return {
      timezone: zone,
      utc_iso: now.toISOString(),
      error: "invalid_timezone",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Harness local adapters: every route must return a payload valid under compiled output_schema. */
function harnessInvokeAdapter({ request, adapter }) {
  switch (adapter.route) {
    case "time.get":
      return harnessSimulateTimeGet(request.input);
    case "particle.update":
      return { ok: "harness_stub" };
    case "context.snapshot": {
      const inp = request.input;
      const scope =
        inp !== null && typeof inp === "object" && !Array.isArray(inp) && "scope" in inp
          ? String(/** @type {Record<string, unknown>} */ (inp).scope)
          : "";
      return { scope, snapshot: {} };
    }
    default:
      throw new Error(`harness: no local adapter for route ${adapter.route}`);
  }
}

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

/**
 * MiniMax-style models sometimes wrap tool calls in XML inside prose when json_object still returns text.
 * Recover hai.time.get only when the user prompt is a time question (fail-closed otherwise).
 */
function tryRecoverDraftFromToolCallMarkup(raw, trimmed, clientTimezone) {
  if (typeof raw !== "string" || !isTimeQuestionPrompt(trimmed)) {
    return null;
  }
  const invokeRe = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let m;
  while ((m = invokeRe.exec(raw)) !== null) {
    let cap = m[1].trim();
    const inner = m[2];
    if (cap === "get_time") cap = "hai.time.get";
    if (cap !== "hai.time.get") continue;
    const tzMatch = /<parameter\s+name=["']timezone["']>([^<]*)<\/parameter>/i.exec(inner);
    let tz = tzMatch ? tzMatch[1].trim() : "";
    if (!tz && clientTimezone) tz = clientTimezone;
    return { capability: "hai.time.get", input: tz ? { timezone: tz } : {} };
  }
  return null;
}

/**
 * Some models emit { type: "tool_use", name, input, ... } or { type: "text", text } under json_object.
 * Map only known patterns; unknown shapes remain hostile (strictDraftShape fails).
 */
function normalizeHostileDraftJson(parsed, trimmed, clientTimezone) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed.type === "tool_use" && typeof parsed.name === "string") {
    const rawName = parsed.name.trim();
    const aliases = {
      get_time: "hai.time.get",
      getTime: "hai.time.get",
      time_get: "hai.time.get",
    };
    let capability = aliases[rawName];
    if (!capability && /^hai\.[-a-z0-9_.]+$/i.test(rawName)) {
      capability = rawName;
    }
    if (!capability) {
      return parsed;
    }
    const inp = parsed.input;
    let input =
      inp !== null && typeof inp === "object" && !Array.isArray(inp) ? { ...inp } : {};
    if (
      capability === "hai.time.get" &&
      clientTimezone &&
      (input.timezone == null || String(input.timezone).trim() === "")
    ) {
      input = { ...input, timezone: clientTimezone };
    }
    return { capability, input };
  }

  if (
    parsed.type === "text" &&
    typeof parsed.text === "string" &&
    isTimeQuestionPrompt(trimmed)
  ) {
    const input = clientTimezone ? { timezone: clientTimezone } : {};
    return { capability: "hai.time.get", input };
  }

  if (
    parsed.type === "capability" &&
    typeof parsed.name === "string" &&
    parsed.input != null &&
    typeof parsed.input === "object" &&
    !Array.isArray(parsed.input)
  ) {
    const cap = parsed.name.trim();
    let input = { ...parsed.input };
    if (
      cap === "hai.time.get" &&
      clientTimezone &&
      (input.timezone == null || String(input.timezone).trim() === "")
    ) {
      input = { ...input, timezone: clientTimezone };
    }
    return { capability: cap, input };
  }

  /* Plain assistant reply JSON { "response": "..." } instead of capability draft */
  if (
    typeof parsed.response === "string" &&
    !("capability" in parsed) &&
    isTimeQuestionPrompt(trimmed)
  ) {
    const input = clientTimezone ? { timezone: clientTimezone } : {};
    return { capability: "hai.time.get", input };
  }

  /* Alternate field names some models use instead of capability / input */
  if (
    typeof parsed.capability_name === "string" &&
    parsed.input_parameters != null &&
    typeof parsed.input_parameters === "object" &&
    !Array.isArray(parsed.input_parameters)
  ) {
    const cap = parsed.capability_name.trim();
    let input = { ...parsed.input_parameters };
    if (
      cap === "hai.time.get" &&
      clientTimezone &&
      (input.timezone == null || String(input.timezone).trim() === "")
    ) {
      input = { ...input, timezone: clientTimezone };
    }
    return { capability: cap, input };
  }

  return parsed;
}

app.get("/governance/capabilities", (_req, res) => {
  const capabilities = registry.listCapabilities().map((def) => {
    const meta = registry.getCapabilityMeta(def.capability, def.version);
    return {
      capability: def.capability,
      version: def.version,
      execution_class: meta?.execution_class ?? null,
      authority_requirements: meta?.authority_requirements ?? null,
    };
  });
  res.json({ ok: true, capabilities });
});

app.get("/governance/receipts", (req, res) => {
  const limit = Number(req.query.limit) || 20;
  res.json({ ok: true, receipts: governanceRuntime.listRecentReceipts(limit) });
});

app.get("/governance/chain-health", (_req, res) => {
  res.json({ ok: true, chain: governanceRuntime.verifyReceiptChain() });
});

app.get("/governance/replays", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const entries = governanceRuntime.listReplayEntries(limit);
  res.json({ ok: true, count: entries.length, entries });
});

app.get("/governance/invariants", (_req, res) => {
  res.json({ ok: true, invariants: collectGovernanceStartupInvariants(registry, governanceRuntime) });
});

app.get("/governance/health", (_req, res) => {
  const health = getGovernanceHealthStatus(registry, governanceRuntime);
  res.json({ ok: health.ok, health });
});

/**
 * CORE CONTRACT (frozen — see test/harness-core-contract.test.mjs):
 * - intentResult.mode === "conversation" → llmText only; return { final }; never llmJsonObject /
 *   strictDraftShape / governed execution.
 * - Else → llmJsonObject → normalizeHostileDraftJson → strictDraftShape →
 *   optional client timezone fill for hai.time.get → executeGovernedCapability (fail-closed: admission + output validation + receipt).
 *   For hai.time.get success, harnessSimulateTimeGet + optional llmText fuse → `final` (surface) + `time` (truth).
 * Do not merge paths, share post-handlers, or branch on intentResult.mode after execution starts.
 */
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

    const { prompt, client_timezone: rawTz } = req.body;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, stage: "request", error: "prompt_required" });
    }

    const trimmed = prompt.trim();
    const clientTimezone = sanitizeClientTimezone(
      typeof rawTz === "string" ? rawTz : ""
    );

    const intentResult = classifyGeneratePrompt(trimmed);
    const genTrace = [{ step: "intent", mode: intentResult.mode, scope: intentResult.scope }];

    if (intentResult.mode === "conversation") {
      const finalRaw = await llmText(llm, intentResult.replyTo || trimmed);
      const final = (finalRaw ?? "").trim();
      if (!final) {
        return res.json({
          ok: false,
          mode: "conversation",
          stage: "conversation_empty",
          error: "model_returned_no_text",
          trace: genTrace,
        });
      }
      return res.json({
        ok: true,
        mode: "conversation",
        stage: "done",
        final,
        trace: genTrace,
      });
    }

    // Execution only below — llmJsonObject must not run for conversation
    let execPrompt = trimmed;
    if (clientTimezone && isTimeQuestionPrompt(trimmed)) {
      execPrompt = `${trimmed}\n\n(Use capability "hai.time.get" with input.timezone ${JSON.stringify(
        clientTimezone
      )} so the host shows the user's local time.)`;
    }
    const text = await llmJsonObject(llm, execPrompt);
    if (!text) {
      return res.json({
        ok: false,
        mode: "execution",
        stage: "model",
        error: "empty_model_output",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const recovered = tryRecoverDraftFromToolCallMarkup(text, trimmed, clientTimezone);
      if (!recovered) {
        return res.json({
          ok: false,
          mode: "execution",
          stage: "parse",
          error: "invalid_json",
          raw: text,
        });
      }
      parsed = recovered;
    }

    parsed = normalizeHostileDraftJson(parsed, trimmed, clientTimezone);

    let shaped;
    try {
      shaped = strictDraftShape(parsed);
    } catch (shapeErr) {
      return res.json({
        ok: false,
        mode: "execution",
        stage: "shape",
        error: shapeErr?.message ?? String(shapeErr),
        draft: parsed,
      });
    }

    if (
      clientTimezone &&
      shaped.capability === "hai.time.get" &&
      typeof shaped.input === "object" &&
      shaped.input !== null &&
      !Array.isArray(shaped.input)
    ) {
      const tz = /** @type {Record<string, unknown>} */ (shaped.input).timezone;
      if (tz == null || (typeof tz === "string" && tz.trim() === "")) {
        shaped = {
          capability: shaped.capability,
          input: { ...shaped.input, timezone: clientTimezone },
        };
      }
    }

    const exec = await executeGovernedCapability(
      registry,
      {
        capability: shaped.capability,
        input: shaped.input,
        context: { constitution_id: CONSTITUTION_ID },
      },
      {
        authorityContext: resolveAuthorityContextForRequest(req),
        governanceRuntime,
        invokeAdapter: harnessInvokeAdapter,
      }
    );

    if (!exec.ok) {
      return res.json(buildExecutionFailureBody(exec, shaped));
    }

    /** @type {Record<string, unknown>} */
    const successBody = buildExecutionSuccessBody(exec);

    const timePayload =
      exec.request.capability === "hai.time.get" ? exec.output : null;

    /** @type {Record<string, unknown>} */
    let withTime = successBody;
    if (exec.request.capability === "hai.time.get" && timePayload !== null) {
      withTime = { ...successBody, time: timePayload };
    }

    if (
      timePayload !== null &&
      typeof timePayload === "object" &&
      !Array.isArray(timePayload) &&
      !timePayload.error &&
      typeof timePayload.local_display === "string" &&
      timePayload.local_display.length > 0
    ) {
      const fusePrompt = `The user said:
${trimmed}

Verified clock (use only this for the time; do not invent another):
- Time zone: ${String(timePayload.timezone)}
- Local: ${timePayload.local_display}
- UTC: ${String(timePayload.utc_iso)}

Write one short plain-text reply (no JSON, no markdown fences). Acknowledge any casual part of their message, then state the local time naturally.`;
      const fuseRaw = await llmText(llm, fusePrompt);
      const fused = (fuseRaw ?? "").trim();
      if (fused) {
        withTime.final = fused;
      }
    }

    return res.json(withTime);
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

    const trimmed = prompt.trim();
    const route = classifyIntent(trimmed);
    trace.push({ step: "intent", mode: route });

    if (route === "conversation") {
      const convPrompt = `You are a helpful assistant. Reply with plain text only (no JSON, no markdown code fences unless the user asks for code). Be concise.

User:
${trimmed}`;
      const finalRaw = await llmText(llm, convPrompt);
      const finalText = finalRaw?.trim() ?? "";
      trace.push({ step: "conversation_model", ok: finalText.length > 0, model: llm.model });
      if (!finalText) {
        return res.json({
          ok: false,
          mode: "conversation",
          stage: "conversation_empty",
          error: "model_returned_no_text",
          trace,
        });
      }
      trace.push({ step: "conversation_return", ok: true });
      return res.json({
        ok: true,
        mode: "conversation",
        stage: "done",
        final: finalText,
        trace,
      });
    }

    const decisionInput = `${AGENT_DECISION_INSTRUCTIONS}\n\nUser request:\n${trimmed}`;
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
        mode: "execution",
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
        mode: "execution",
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
        mode: "execution",
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
        mode: "execution",
        stage: "done",
        final: decisionParsed.message,
        trace,
        raw: { decision: decisionParsed, tool_result: null },
      });
    }

    const toolResult = runToolEcho(decisionParsed.arguments);
    trace.push({ step: "tool", ...toolResult });

    const finalizeInput = `The user asked:\n${trimmed}\n\nThe echo tool was invoked and returned this JSON:\n${JSON.stringify(
      toolResult.output
    )}\n\nWrite a single short plain-text reply to the user that incorporates this result. No JSON, no bullet meta-commentary.`;
    const finalRaw = await llmText(llm, finalizeInput);
    const finalText = finalRaw?.trim() ?? "";
    trace.push({ step: "finalize_model", ok: finalText.length > 0 });

    if (!finalText) {
      return res.json({
        ok: false,
        mode: "execution",
        stage: "finalize_empty",
        error: "model_returned_no_final_text",
        decision: decisionParsed,
        tool_result: toolResult,
        trace,
      });
    }

    return res.json({
      ok: true,
      mode: "execution",
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
      "Membrane uses register + admit + execute over the engine proxy; wire a client or set a gateway. This harness does not implement /admit here.",
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
