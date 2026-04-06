/**
 * Deterministic routing: no model.
 * @param {string} s
 * @param {string} word
 * @param {{ skipIfPrevDot?: boolean }} [opts]
 */
function hasWord(s, word, opts = {}) {
  const re = new RegExp(`\\b${word}\\b`, "gi");
  let m;
  while ((m = re.exec(s)) !== null) {
    if (opts.skipIfPrevDot && m.index > 0 && s[m.index - 1] === ".") {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Last line looks like scaffold / example / rule from the draft template — not a casual closing remark.
 * @param {string} line
 */
function lastLineLooksLikeDraftInstruction(line) {
  const s = line.trim();
  if (!s) return true;
  if (/hai\.particle\./i.test(s)) return true;
  if (/^\s*[-*]\s/.test(s)) return true;
  if (/\bOutput\s+ONLY\s+JSON\b/i.test(s)) return true;
  if (/\bcapability\s+request\b/i.test(s)) return true;
  if (/\bgenerating\s+a\s+capability\b/i.test(s)) return true;
  if (/\{\s*["']?(revision|capability|input)["']?\s*:/i.test(s)) return true;
  if (/^\s*\{/.test(s) && /"[^"]+"\s*:/.test(s)) return true;
  return false;
}

/**
 * Natural-language time questions → route to hai.time.get (see /generate execution path).
 * @param {string} input
 */
export function isTimeQuestionPrompt(input) {
  if (typeof input !== "string") return false;
  const s = input.trim();
  if (!s) return false;
  return (
    /\bwhat\s+time\s+is\s+it\b/i.test(s) ||
    /\bwhat\s+time\s+it\s+is\b/i.test(s) ||
    /\bwhat['’]s\s+the\s+time\b/i.test(s) ||
    /\bcurrent\s+time\b/i.test(s) ||
    /\btime\s+right\s+now\b/i.test(s) ||
    /\btell\s+me\s+the\s+time\b/i.test(s)
  );
}

/**
 * @param {string} input
 * @returns {"conversation" | "execution"}
 */
export function classifyIntent(input) {
  if (typeof input !== "string") return "conversation";
  const s = input.trim();
  if (!s) return "conversation";

  if (/\bcapability\s+request\b/i.test(s)) return "execution";
  if (/\bgenerating\s+a\s+capability\b/i.test(s)) return "execution";
  if (/\bgenerate\s+capability\b/i.test(s)) return "execution";

  for (const w of ["call", "set", "write", "execute"]) {
    if (hasWord(s, w)) return "execution";
  }
  if (hasWord(s, "update", { skipIfPrevDot: true })) return "execution";

  /* Host can satisfy via hai.time.get; conversation models often refuse "real-time". */
  if (isTimeQuestionPrompt(s)) return "execution";

  return "conversation";
}

/**
 * /generate routing only (frozen — do not fold into execution validation).
 * Final non-empty line wins when it is clearly casual chat (not draft-shaped).
 * `mode` duplicates `route` so handlers can use intentResult.mode === "conversation".
 * @param {string} trimmed
 * @returns {{ route: "conversation" | "execution"; mode: "conversation" | "execution"; replyTo: string; scope: "full" | "last_line" }}
 * `mode` is always the same as `route` (alias for callers that use `intentResult.mode`).
 */
export function classifyGeneratePrompt(trimmed) {
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";

  if (
    lastLine &&
    !lastLineLooksLikeDraftInstruction(lastLine) &&
    classifyIntent(lastLine) === "conversation"
  ) {
    const scope = lines.length >= 2 && lastLine !== trimmed ? "last_line" : "full";
    return { route: "conversation", mode: "conversation", replyTo: lastLine, scope };
  }

  if (classifyIntent(trimmed) === "conversation") {
    return { route: "conversation", mode: "conversation", replyTo: trimmed, scope: "full" };
  }

  return { route: "execution", mode: "execution", replyTo: trimmed, scope: "full" };
}
