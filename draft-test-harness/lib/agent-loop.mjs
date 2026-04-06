/**
 * Pre-ZAK sandbox: intent → decision → (optional tool) → final.
 * Model output is hostile until validated; no second chances.
 */

export const AGENT_DECISION_INSTRUCTIONS = `You are an execution agent.

For every user request you MUST output exactly one JSON object and nothing else (no markdown).

The JSON object MUST have exactly these keys and no others:
- "intent" (string): one-line classification of what the user wants
- "decision" (string): exactly "respond_directly" OR "call_tool"
- "tool" (null or string): MUST be null when decision is "respond_directly". MUST be "echo" when decision is "call_tool"
- "arguments" (object): MUST be {} when decision is "respond_directly". When calling echo, MUST be { "text": "<string>" }
- "message" (string or null): When decision is "respond_directly", your complete final answer to the user (non-empty string). When decision is "call_tool", MUST be null

Never mix: if you respond directly, do not call a tool. If you call a tool, do not put a user-facing answer in message.

The only tool name allowed is "echo".`;

/**
 * @returns {string | null} error code / message, or null if valid
 */
export function validateDecision(d) {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    return "decision_not_object";
  }
  const allowed = new Set(["intent", "decision", "tool", "arguments", "message"]);
  for (const k of Object.keys(d)) {
    if (!allowed.has(k)) return `extra_field:${k}`;
  }
  for (const k of allowed) {
    if (!(k in d)) return `missing_field:${k}`;
  }
  if (typeof d.intent !== "string") return "intent_type";
  if (d.decision !== "respond_directly" && d.decision !== "call_tool") {
    return "decision_enum";
  }
  if (d.tool !== null && typeof d.tool !== "string") return "tool_type";
  if (d.arguments === null || typeof d.arguments !== "object" || Array.isArray(d.arguments)) {
    return "arguments_type";
  }
  if (d.message !== null && typeof d.message !== "string") return "message_type";

  if (d.decision === "respond_directly") {
    if (d.tool !== null) return "respond_directly_requires_tool_null";
    if (Object.keys(d.arguments).length !== 0) return "respond_directly_requires_empty_arguments";
    if (!String(d.message).trim()) return "respond_directly_requires_message";
  }

  if (d.decision === "call_tool") {
    if (d.tool !== "echo") return "call_tool_requires_echo";
    if (typeof d.arguments.text !== "string") return "echo_requires_arguments.text_string";
    if (d.message !== null) return "call_tool_requires_message_null";
  }

  return null;
}

export function runToolEcho(argumentsObj) {
  const text = argumentsObj.text;
  return { tool: "echo", input: { text }, output: { text } };
}
