import assert from "node:assert/strict";
import test from "node:test";
import { classifyGeneratePrompt, classifyIntent } from "../lib/intent-classify.mjs";

test("how are you today? → conversation", () => {
  assert.equal(classifyIntent("how are you today?"), "conversation");
});

test("hey how are you? → conversation", () => {
  assert.equal(classifyIntent("hey how are you?"), "conversation");
});

test("what time is it? → execution (hai.time.get path)", () => {
  assert.equal(classifyIntent("What time is it?"), "execution");
  assert.equal(
    classifyIntent("Hey how are you? What time is it?"),
    "execution"
  );
});

test("what's the time → execution", () => {
  assert.equal(classifyIntent("what's the time"), "execution");
});

test("tell me the current time → execution", () => {
  assert.equal(classifyIntent("Tell me the current time"), "execution");
});

test("tell me what time it is → execution", () => {
  assert.equal(classifyIntent("Tell me what time it is"), "execution");
});

test("update particle … → execution", () => {
  assert.equal(
    classifyIntent("update particle demo-1 with hue 0.5 and revision 1"),
    "execution"
  );
});

test("call echo … → execution", () => {
  assert.equal(classifyIntent("call echo with hi and explain it"), "execution");
});

test("generate capability … → execution", () => {
  assert.equal(classifyIntent("Please generate capability draft for X"), "execution");
});

test("no false positive: so-called", () => {
  assert.equal(classifyIntent("This is so-called free speech"), "conversation");
});

test("route suffix .update is not an 'update' verb", () => {
  assert.equal(
    classifyIntent('id is "hai.particle.update" only'),
    "conversation"
  );
});

test("draft phrasing still → execution", () => {
  const tmpl = `You are generating a capability request draft.

Rules:
- capability must be "hai.particle.update"`;
  assert.equal(classifyIntent(tmpl), "execution");
});

test("classifyGeneratePrompt: template + trailing chat → conversation, last line", () => {
  const tmpl = `You are generating a capability request draft.
Rules:
- capability must be "hai.particle.update"`;
  const r = classifyGeneratePrompt(`${tmpl}\n\nhow are you today?`);
  assert.equal(r.route, "conversation");
  assert.equal(r.replyTo, "how are you today?");
  assert.equal(r.scope, "last_line");
});

test("classifyGeneratePrompt: single-line small talk → conversation, scope full", () => {
  const r = classifyGeneratePrompt("how are you today?");
  assert.equal(r.route, "conversation");
  assert.equal(r.replyTo, "how are you today?");
  assert.equal(r.scope, "full");
});

test("classifyGeneratePrompt: small talk + time question → execution", () => {
  const r = classifyGeneratePrompt("Hey how are you? What time is it?");
  assert.equal(r.mode, "execution");
});

test("classifyGeneratePrompt: single-line execution stays execution", () => {
  const r = classifyGeneratePrompt("update particle demo-1");
  assert.equal(r.route, "execution");
  assert.equal(r.replyTo, "update particle demo-1");
  assert.equal(r.scope, "full");
});

test("classifyGeneratePrompt: default-style template only → execution (last line is example JSON)", () => {
  const tmpl = `You are generating a capability request draft.

Output ONLY JSON. Top-level keys must be exactly "capability" and "input" — no others.

Rules:
- capability must be "hai.particle.update"
- input.particle_id: non-empty string (e.g. "demo-1")
- input.attributes MUST match registry latest (v2): include revision (integer >= 0). You may add hue (number in [0, 1]) if you want; revision is still required.

Example input.attributes: { "revision": 1, "hue": 0.5 }`;
  const r = classifyGeneratePrompt(tmpl);
  assert.equal(r.route, "execution");
});
