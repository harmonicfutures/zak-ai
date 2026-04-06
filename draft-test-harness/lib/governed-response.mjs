export function assertValidatedExecutionSuccess(exec) {
  if (!exec || exec.ok !== true) {
    throw new Error("governed success body requires ok=true execution result");
  }
  if (exec.stage !== "executed") {
    throw new Error(`governed success body requires terminal executed stage, got ${String(exec.stage)}`);
  }
  if (!exec.receipt || exec.receipt.output_validation_passed !== true) {
    throw new Error("governed success body requires output_validation_passed=true receipt");
  }
}

export function buildExecutionSuccessBody(exec) {
  assertValidatedExecutionSuccess(exec);
  return {
    ok: true,
    mode: "execution",
    stage: exec.stage,
    request: exec.request,
    adapter: exec.adapter,
    receipt: exec.receipt,
    output: exec.output,
  };
}

export function buildExecutionFailureBody(exec, draft) {
  return {
    ok: false,
    mode: "execution",
    stage: exec.stage,
    errors: exec.errors,
    ...(exec.request ? { request: exec.request, adapter: exec.adapter } : {}),
    ...(exec.receipt ? { receipt: exec.receipt } : {}),
    draft,
  };
}
