import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidatedExecutionSuccess,
  buildExecutionFailureBody,
  buildExecutionSuccessBody,
} from "../lib/governed-response.mjs";

test("harness success response includes output and persisted receipt metadata", () => {
  const exec = {
    ok: true,
    stage: "executed",
    request: { capability: "hai.time.get", capability_version: "1.0.0" },
    adapter: { key: "hai-adapter", route: "time.get" },
    output: { timezone: "UTC" },
    receipt: {
      capability: "hai.time.get",
      version: "1.0.0",
      capability_definition_hash: "sha256:1234",
      authority_level_used: "none",
      authority: {
        resolved_authority_level: "none",
        source: "test",
        evaluated_at: "2026-04-06T12:00:00.000Z",
      },
      execution_class: "A",
      timestamp: "2026-04-06T12:00:00.000Z",
      stage: "executed",
      success: true,
      output_validation_passed: true,
      receipt_hash: "sha256:abcd",
      prev_receipt_hash: null,
      environment_id: "test",
      runtime_id: "harness",
      chain_key: "env:test|runtime:harness|session:-|subject:-",
    },
  };
  const body = buildExecutionSuccessBody(exec);
  assert.equal(body.ok, true);
  assert.equal(body.stage, "executed");
  assert.deepEqual(body.request, exec.request);
  assert.deepEqual(body.adapter, exec.adapter);
  assert.deepEqual(body.output, exec.output);
  assert.equal(body.receipt.receipt_hash, "sha256:abcd");
});

test("harness failure response includes stage structured errors and receipt when present", () => {
  const exec = {
    stage: "admission",
    errors: [{ message: "replay blocked" }],
    request: { capability: "hai.particle.update", capability_version: "2.0.0" },
    adapter: { key: "hai-adapter", route: "particle.update" },
    receipt: { receipt_hash: "sha256:deadbeef", stage: "admission", success: false },
  };
  const body = buildExecutionFailureBody(exec, { capability: "hai.particle.update", input: {} });
  assert.equal(body.ok, false);
  assert.equal(body.stage, "admission");
  assert.deepEqual(body.errors, exec.errors);
  assert.equal(body.receipt.receipt_hash, "sha256:deadbeef");
  assert.deepEqual(body.draft, { capability: "hai.particle.update", input: {} });
});

test("forced bypass attempt on output validation is rejected at success boundary", () => {
  assert.throws(() =>
    assertValidatedExecutionSuccess({
      ok: true,
      stage: "executed",
      output: { timezone: "UTC" },
      request: {},
      adapter: {},
      receipt: { output_validation_passed: false },
    })
  );
});
