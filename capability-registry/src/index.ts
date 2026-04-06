export type {
  CapabilityAdapterBinding,
  CapabilityDefinition,
  SemanticValidationResult,
  SemanticValidator,
  ValidationErrorItem,
  ValidationResult,
  ZakIdeBridgeRequest,
  ZakIdeBridgeRequestDraft,
} from "./types";
export { CapabilityRegistry } from "./registry";
export {
  loadCapabilityBundlesFromDirectory,
  loadDefinitionsFromCapabilitiesDirectory,
  parseDefinitionJson,
  registerCapabilitiesFromDirectory,
  resolveDefaultCapabilitiesRoot,
  type CapabilityBundle,
  type CapabilityLogger,
  type LoadFromDiskOptions,
} from "./load-capabilities-from-disk";
export {
  collectExecutionClassPolicyViolations,
  parseCapabilityCompiledMeta,
  type AuthorityRequirement,
  type CapabilityCompiledMeta,
  type ExecutionClass,
  type IdempotencyMode,
  type ReplayBehavior,
  type SideEffectTier,
} from "./capability-meta";
export {
  assertReplayAllowed,
  checkAdmissionPolicy,
  defaultClassPolicyHook,
  idempotencyKeyFromInput,
  replayBlockedLookupKey,
  resolveAuthorityContext,
  resolveExecutionAuthorityContext,
  stableInputKeyForReplay,
  validateAuthorityContext,
  validateAdapterOutput,
  type AdmissionAuthorityLevel,
  type AdmissionPolicyOptions,
  type AuthorityContext,
  type ClassPolicyHook,
} from "./enforcement";
export {
  createFileGovernanceRuntime,
  type ExecutionReceipt,
  type GovernanceInvariant,
  type IdempotencyLookupResult,
  type GovernanceRuntime,
  type GovernanceRuntimeOptions,
  type ReceiptAnchor,
  type ReceiptAnchorVerification,
  type ReceiptChainVerification,
  type ReplayLedgerEntry,
  type ReplayLedgerVerification,
} from "./governance-runtime";
export { computeCapabilityDefinitionHash } from "./definition-hash";
export {
  prepareExecutionRequest,
  validateAdapterOutputForCapability,
  type PrepareExecutionOptions,
  type PrepareExecutionResult,
  type PrepareFailureStage,
} from "./bridge";
export {
  executeGovernedCapability,
  type ExecuteGovernedCapabilityOptions,
  type GovernedAdapterContext,
  type GovernedExecutionFailure,
  type GovernedExecutionResult,
  type GovernedSuccessStage,
  type GovernedExecutionSuccess,
  type GovernedExecutionOptions,
  type GovernedFailureStage,
} from "./governed-execution";
export {
  registerBuiltinSemanticValidators,
  semanticParticleUpdateV1,
  semanticParticleUpdateV2,
} from "./builtins";
export { definitionsForFormShaping, getDefinitionForUi } from "./ui";
export { pickLatestVersion } from "./version-sort";

import { CapabilityRegistry } from "./registry";
import { registerBuiltinSemanticValidators } from "./builtins";
import { collectExecutionClassPolicyViolations } from "./capability-meta";
import {
  loadDefinitionsFromCapabilitiesDirectory,
  registerCapabilitiesFromDirectory,
  resolveDefaultCapabilitiesRoot,
  type CapabilityLogger,
  type LoadFromDiskOptions,
} from "./load-capabilities-from-disk";
import type { GovernanceInvariant, GovernanceRuntime } from "./governance-runtime";

export interface GovernanceHealthStatus {
  ok: boolean;
  reasons: string[];
  invariants: GovernanceInvariant[];
  receipt_chain: ReturnType<GovernanceRuntime["verifyReceiptChain"]>;
  receipt_anchors: ReturnType<GovernanceRuntime["verifyReceiptAnchors"]>;
  replay_ledger: ReturnType<GovernanceRuntime["verifyReplayLedgerConsistency"]>;
}

const silentLogger: CapabilityLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * (capability, version) rows for the membrane whitelist — derived from compiled definitions only.
 */
export function suggestedMembraneSnapshotPairs(rootDir?: string): { capability: string; version: string }[] {
  const root = rootDir ?? resolveDefaultCapabilitiesRoot();
  return loadDefinitionsFromCapabilitiesDirectory(root, {
    logger: silentLogger,
  }).map((d) => ({ capability: d.capability, version: d.version }));
}

export interface CreateCompiledRegistryOptions extends LoadFromDiskOptions {
  /** Default true: attach particle semantic validators after definitions load. */
  registerSemanticValidators?: boolean;
}

/**
 * **Production registry:** load exclusively from `capabilities/` (flat + optional `<cap>/<semver>/` trees),
 * verify each `definition.hash`, register built-in semantics (particle v1/v2).
 */
export function assertRegistryGovernanceInvariants(registry: CapabilityRegistry): void {
  for (const def of registry.listCapabilities()) {
    const meta = registry.getCapabilityMeta(def.capability, def.version);
    if (!meta) {
      throw new Error(`governance invariant: meta missing for ${def.capability}@${def.version}`);
    }
    const viol = collectExecutionClassPolicyViolations(meta);
    if (viol.length > 0) {
      throw new Error(
        `governance invariant: ${def.capability}@${def.version}: ${viol.map((v) => v.message).join("; ")}`
      );
    }
  }
}

export function collectGovernanceStartupInvariants(
  registry: CapabilityRegistry,
  runtime: GovernanceRuntime
): GovernanceInvariant[] {
  const invariants = [...runtime.startupInvariants()];
  for (const def of registry.listCapabilities()) {
    const meta = registry.getCapabilityMeta(def.capability, def.version);
    invariants.push({
      scope: "startup",
      ok: Boolean(meta),
      target: "meta",
      message: meta
        ? `meta present for ${def.capability}@${def.version}`
        : `meta missing for ${def.capability}@${def.version}`,
    });
    invariants.push({
      scope: "startup",
      ok: Boolean(meta && typeof meta.output_schema === "object" && meta.output_schema !== null),
      target: "output_schema",
      message:
        meta && typeof meta.output_schema === "object" && meta.output_schema !== null
          ? `output schema present for ${def.capability}@${def.version}`
          : `output schema missing for ${def.capability}@${def.version}`,
    });
  }
  return invariants;
}

export function assertGovernanceStartupInvariants(
  registry: CapabilityRegistry,
  runtime: GovernanceRuntime
): void {
  assertRegistryGovernanceInvariants(registry);
  const failing = collectGovernanceStartupInvariants(registry, runtime).find((inv) => !inv.ok);
  if (failing) {
    throw new Error(`governance startup invariant failed (${failing.target}): ${failing.message}`);
  }
}

export function getGovernanceHealthStatus(
  registry: CapabilityRegistry,
  runtime: GovernanceRuntime
): GovernanceHealthStatus {
  const invariants = collectGovernanceStartupInvariants(registry, runtime);
  const receipt_chain = runtime.verifyReceiptChain();
  const receipt_anchors = runtime.verifyReceiptAnchors();
  const replay_ledger = runtime.verifyReplayLedgerConsistency();
  const reasons = [
    ...invariants.filter((inv) => !inv.ok).map((inv) => `${inv.target}: ${inv.message}`),
    ...receipt_chain.errors.map((e) => `receipt_chain: ${e}`),
    ...receipt_anchors.errors.map((e) => `receipt_anchor: ${e}`),
    ...replay_ledger.errors.map((e) => `replay_ledger: ${e}`),
  ];
  return {
    ok: reasons.length === 0,
    reasons,
    invariants,
    receipt_chain,
    receipt_anchors,
    replay_ledger,
  };
}

export function createRegistryFromCompiledCapabilities(
  rootDir: string,
  options?: CreateCompiledRegistryOptions
): CapabilityRegistry {
  const r = new CapabilityRegistry();
  registerCapabilitiesFromDirectory(r, rootDir, options);
  if (options?.registerSemanticValidators !== false) {
    registerBuiltinSemanticValidators(r);
  }
  assertRegistryGovernanceInvariants(r);
  return r;
}

/**
 * Same as {@link createRegistryFromCompiledCapabilities} using {@link resolveDefaultCapabilitiesRoot}.
 */
export function createRegistryWithDefaultCapabilitiesRoot(options?: CreateCompiledRegistryOptions): CapabilityRegistry {
  return createRegistryFromCompiledCapabilities(resolveDefaultCapabilitiesRoot(), options);
}
