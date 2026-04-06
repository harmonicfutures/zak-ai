import {
  idempotencyKeyFromInput,
  replayBlockedLookupKey,
  resolveExecutionAuthorityContext,
  type AdmissionPolicyOptions,
  type AuthorityContext,
} from "./enforcement";
import {
  prepareExecutionRequest,
  validateAdapterOutputForCapability,
  type PrepareFailureStage,
} from "./bridge";
import type { ExecutionClass } from "./capability-meta";
import type { ExecutionReceipt, GovernanceRuntime } from "./governance-runtime";
import type { CapabilityRegistry } from "./registry";
import type {
  CapabilityAdapterBinding,
  ValidationErrorItem,
  ZakIdeBridgeRequest,
  ZakIdeBridgeRequestDraft,
} from "./types";

export type GovernedFailureStage = PrepareFailureStage | "adapter" | "output_validation" | "receipt_persistence";

export type GovernedSuccessStage = "executed";

export type GovernedExecutionSuccess = {
  ok: true;
  stage: GovernedSuccessStage;
  output: unknown;
  receipt: ExecutionReceipt;
  request: ZakIdeBridgeRequest;
  adapter: CapabilityAdapterBinding;
};

export type GovernedExecutionFailure = {
  ok: false;
  stage: GovernedFailureStage;
  errors: ValidationErrorItem[];
  receipt?: ExecutionReceipt;
  request?: ZakIdeBridgeRequest;
  adapter?: CapabilityAdapterBinding;
};

export type GovernedExecutionResult = GovernedExecutionSuccess | GovernedExecutionFailure;

export interface GovernedExecutionOptions extends AdmissionPolicyOptions {
  authorityContext: AuthorityContext;
  governanceRuntime: GovernanceRuntime;
}

export interface GovernedAdapterContext {
  request: ZakIdeBridgeRequest;
  adapter: CapabilityAdapterBinding;
}

/**
 * Finish governed execution after the host has run the adapter: mandatory output validation,
 * durable receipt, durable replay bookkeeping.
 */
export interface ExecuteGovernedCapabilityOptions extends GovernedExecutionOptions {
  invokeAdapter: (ctx: GovernedAdapterContext) => unknown | Promise<unknown>;
}

/**
 * Single governed pipeline: validate input → admission (incl. class policy + replay gate) → adapter → output validation → receipt.
 */
export async function executeGovernedCapability(
  registry: CapabilityRegistry,
  draft: ZakIdeBridgeRequestDraft,
  options: ExecuteGovernedCapabilityOptions
): Promise<GovernedExecutionResult> {
  options.governanceRuntime.assertStartupInvariants();
  const resolvedAuthority = resolveExecutionAuthorityContext(draft, options.governanceRuntime, options.authorityContext);
  const resolved = registry.resolveDefinitionForExecution(draft.capability, draft.capability_version);
  const resolvedMeta = resolved
    ? registry.getCapabilityMeta(resolved.definition.capability, resolved.version)
    : undefined;

  const prep = prepareExecutionRequest(registry, draft, options);
  if (!prep.ok) {
    const receipt = persistReceiptSafe(options.governanceRuntime, {
      capability: draft.capability,
      version: resolved?.version ?? draft.capability_version ?? null,
      capability_definition_hash: null,
      authority: resolvedAuthority,
      execution_class: resolvedMeta?.execution_class ?? null,
      stage: prep.stage,
      success: false,
      errors: prep.errors,
    });
    return { ok: false, stage: prep.stage, errors: prep.errors, ...(receipt ? { receipt } : {}) };
  }

  const { request, adapter } = prep;
  const meta = registry.getCapabilityMeta(request.capability, request.capability_version);
  if (!meta) {
    const errors = [
      {
        message: `governance metadata missing for ${request.capability}@${request.capability_version}`,
      },
    ];
    const receipt = persistReceiptSafe(options.governanceRuntime, {
      capability: request.capability,
      version: request.capability_version,
      capability_definition_hash: request.capability_definition_hash ?? null,
      authority: resolvedAuthority,
      execution_class: null,
      stage: "governance_meta",
      success: false,
      errors,
    });
    return {
      ok: false,
      stage: "governance_meta",
      errors,
      request,
      adapter,
      ...(receipt ? { receipt } : {}),
    };
  }

  let rawOutput: unknown;
  try {
    rawOutput = await Promise.resolve(
      options.invokeAdapter({ request, adapter })
    );
  } catch (e) {
    const errors = [{ message: `adapter invocation failed: ${(e as Error).message}` }];
    const receipt = persistReceiptSafe(options.governanceRuntime, {
      capability: request.capability,
      version: request.capability_version,
      capability_definition_hash: request.capability_definition_hash ?? null,
      authority: resolvedAuthority,
      execution_class: meta.execution_class,
      stage: "adapter",
      success: false,
      errors,
    });
    return {
      ok: false,
      stage: "adapter",
      errors,
      request,
      adapter,
      ...(receipt ? { receipt } : {}),
    };
  }

  const out = validateAdapterOutputForCapability(
    registry,
    request.capability,
    request.capability_version,
    rawOutput
  );
  if (!out.valid) {
    const receipt = persistReceiptSafe(options.governanceRuntime, {
      capability: request.capability,
      version: request.capability_version,
      capability_definition_hash: request.capability_definition_hash ?? null,
      authority: resolvedAuthority,
      execution_class: meta.execution_class,
      stage: "output_validation",
      success: false,
      output_validation_passed: false,
      errors: out.errors,
    });
    return {
      ok: false,
      stage: "output_validation",
      errors: out.errors,
      request,
      adapter,
      ...(receipt ? { receipt } : {}),
    };
  }

  const replay_key =
    meta.execution_class === "B" &&
    (meta.replay_behavior === "blocked" || meta.replay_behavior === "allowed_same_key")
      ? replayBlockedLookupKey(request.capability, request.capability_version, request.input)
      : undefined;
  const idempotency_key = idempotencyKeyFromInput(request.input);
  const receipt = persistReceiptSafe(options.governanceRuntime, {
    capability: request.capability,
    version: request.capability_version,
    capability_definition_hash: request.capability_definition_hash ?? null,
    authority: resolvedAuthority,
    execution_class: meta.execution_class as ExecutionClass,
    stage: "executed",
    success: true,
    output_validation_passed: true,
    ...(replay_key ? { replay_key } : {}),
    ...(idempotency_key ? { idempotency_key } : {}),
  });
  if (!receipt) {
    return {
      ok: false,
      stage: "receipt_persistence",
      errors: [{ message: "receipt persistence failed after adapter execution" }],
      request,
      adapter,
    };
  }
  assertValidatedSuccessReceipt(receipt);

  return {
    ok: true,
    stage: "executed",
    output: rawOutput,
    receipt,
    request,
    adapter,
  };
}

function persistReceiptSafe(
  runtime: GovernanceRuntime,
  draft: {
    capability: string;
    version: string | null;
    capability_definition_hash: string | null;
    authority: AuthorityContext;
    execution_class: ExecutionClass | null;
    stage: string;
    success: boolean;
    output_validation_passed?: boolean;
    errors?: ValidationErrorItem[];
    replay_key?: string;
    idempotency_key?: string;
  }
): ExecutionReceipt | undefined {
  try {
    return runtime.persistReceipt(draft);
  } catch {
    return undefined;
  }
}

function assertValidatedSuccessReceipt(receipt: ExecutionReceipt): void {
  if (receipt.stage !== "executed" || receipt.output_validation_passed !== true) {
    throw new Error("governed execution success requires executed stage with output_validation_passed=true");
  }
}
