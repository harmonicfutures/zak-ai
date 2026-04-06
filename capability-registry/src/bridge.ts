import { computeCapabilityDefinitionHash } from "./definition-hash";
import type { CapabilityRegistry } from "./registry";
import type {
  CapabilityAdapterBinding,
  ValidationErrorItem,
  ZakIdeBridgeRequest,
  ZakIdeBridgeRequestDraft,
} from "./types";

export type PrepareExecutionResult =
  | {
      ok: true;
      request: ZakIdeBridgeRequest;
      /** Same as registry definition.adapter for this resolved version (single source for host routing). */
      adapter: CapabilityAdapterBinding;
    }
  | { ok: false; errors: ValidationErrorItem[] };

/**
 * Resolve version once, validate (schema + semantic), produce a wire-safe request with explicit capability_version.
 * Call this immediately before enqueue / IPC to the membrane — avoids implicit “latest” on the wire.
 */
export function prepareExecutionRequest(
  registry: CapabilityRegistry,
  draft: ZakIdeBridgeRequestDraft
): PrepareExecutionResult {
  const resolved = registry.resolveDefinitionForExecution(draft.capability, draft.capability_version);
  if (!resolved) {
    return {
      ok: false,
      errors: [
        {
          message: `unknown capability or version: ${draft.capability}${
            draft.capability_version ? `@${draft.capability_version}` : ""
          }`,
        },
      ],
    };
  }
  const { definition, version } = resolved;
  const v = registry.validateInput(draft.capability, draft.input, version);
  if (!v.valid) {
    return { ok: false, errors: v.errors ?? [{ message: "validation failed" }] };
  }
  const capability_definition_hash = computeCapabilityDefinitionHash(definition);
  return {
    ok: true,
    request: {
      capability: draft.capability,
      input: draft.input,
      context: draft.context,
      capability_version: version,
      capability_definition_hash,
    },
    adapter: definition.adapter,
  };
}
