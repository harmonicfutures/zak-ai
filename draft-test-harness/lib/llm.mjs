/**
 * OpenAI Responses API vs OpenRouter (OpenAI-compatible chat completions).
 * OpenRouter does not expose Responses API; use chat.completions there.
 */
import OpenAI from "openai";

export function createHarnessLlm() {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const useOpenRouter = Boolean(openRouterKey);

  const model = useOpenRouter
    ? (process.env.OPENROUTER_MODEL ?? "openrouter/free")
    : (process.env.OPENAI_MODEL ?? "gpt-4o");

  const client = useOpenRouter
    ? new OpenAI({
        apiKey: openRouterKey,
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer":
            process.env.OPENROUTER_HTTP_REFERER ?? "https://github.com/harmonicfutures/zak-ai",
          "X-Title": process.env.OPENROUTER_APP_TITLE ?? "ZAKAI-draft-test-harness",
        },
      })
    : new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

  return { client, model, useOpenRouter };
}

/** @param {{ client: import("openai").OpenAI; model: string; useOpenRouter: boolean }} ctx */
export function hasLlmCredentials(ctx) {
  if (ctx.useOpenRouter) {
    return Boolean(process.env.OPENROUTER_API_KEY?.trim());
  }
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function extractResponsesApiText(response) {
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

/** Chat Completions `message.content`: string or array of text parts (OpenRouter / newer APIs). */
function extractChatCompletionContent(message) {
  if (!message || message.content == null) return null;
  const c = message.content;
  if (typeof c === "string") {
    return c.length > 0 ? c : null;
  }
  if (Array.isArray(c)) {
    const out = c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (part.type === "text" && typeof part.text === "string") return part.text;
        }
        return "";
      })
      .join("");
    return out.length > 0 ? out : null;
  }
  return null;
}

async function openRouterChatCompletionJson(ctx, userPrompt, useJsonObjectMode) {
  const body = {
    model: ctx.model,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (useJsonObjectMode) {
    body.response_format = { type: "json_object" };
  }
  const res = await ctx.client.chat.completions.create(body);
  const raw = extractChatCompletionContent(res.choices?.[0]?.message);
  const text = raw?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/** JSON object mode (strict JSON in reply). */
export async function llmJsonObject(ctx, userPrompt) {
  if (ctx.useOpenRouter) {
    let text = await openRouterChatCompletionJson(ctx, userPrompt, true);
    if (!text) {
      text = await openRouterChatCompletionJson(ctx, userPrompt, false);
    }
    return text;
  }

  const response = await ctx.client.responses.create({
    model: ctx.model,
    input: userPrompt,
    text: { format: { type: "json_object" } },
  });
  return extractResponsesApiText(response);
}

/** Plain text reply. No response_format / JSON mode. */
export async function llmText(ctx, userPrompt) {
  if (ctx.useOpenRouter) {
    const res = await ctx.client.chat.completions.create({
      model: ctx.model,
      messages: [{ role: "user", content: userPrompt }],
    });
    return extractChatCompletionContent(res.choices?.[0]?.message);
  }

  const response = await ctx.client.responses.create({
    model: ctx.model,
    input: userPrompt,
  });
  return extractResponsesApiText(response);
}
