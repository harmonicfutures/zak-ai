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

/** JSON object mode (strict JSON in reply). */
export async function llmJsonObject(ctx, userPrompt) {
  if (ctx.useOpenRouter) {
    const res = await ctx.client.chat.completions.create({
      model: ctx.model,
      messages: [{ role: "user", content: userPrompt }],
      response_format: { type: "json_object" },
    });
    const text = res.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  }

  const response = await ctx.client.responses.create({
    model: ctx.model,
    input: userPrompt,
    text: { format: { type: "json_object" } },
  });
  return extractResponsesApiText(response);
}

/** Plain text reply. */
export async function llmText(ctx, userPrompt) {
  if (ctx.useOpenRouter) {
    const res = await ctx.client.chat.completions.create({
      model: ctx.model,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = res.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  }

  const response = await ctx.client.responses.create({
    model: ctx.model,
    input: userPrompt,
  });
  return extractResponsesApiText(response);
}
