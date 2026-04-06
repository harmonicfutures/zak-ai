import type {
  CapabilityDefinition,
  SemanticValidator,
  ValidationErrorItem,
  ValidationResult,
} from "./types";
import {
  ajvErrorsToItems,
  compileSchema,
  dropCompiled,
  validateAgainstSchema,
} from "./validate";
import { pickLatestVersion } from "./version-sort";

export class CapabilityRegistry {
  private readonly byKey = new Map<string, CapabilityDefinition>();
  private readonly versionsByCapability = new Map<string, Set<string>>();
  private readonly semanticByKey = new Map<string, SemanticValidator>();

  registerCapability(definition: CapabilityDefinition): void {
    const key = this.key(definition.capability, definition.version);
    if (this.byKey.has(key)) {
      dropCompiled(definition.capability, definition.version);
    }
    this.byKey.set(key, { ...definition });
    let set = this.versionsByCapability.get(definition.capability);
    if (!set) {
      set = new Set();
      this.versionsByCapability.set(definition.capability, set);
    }
    set.add(definition.version);
    compileSchema(definition.capability, definition.version, definition.input_schema);
  }

  /**
   * Optional meaning-level validator for this capability@version (runs after Ajv). Host-only.
   */
  registerSemanticValidator(capability: string, version: string, validator: SemanticValidator): void {
    this.semanticByKey.set(this.key(capability, version), validator);
  }

  /**
   * @param version If provided (non-empty), exact match. If omitted or empty, **latest** by semver rules (UI / discovery only).
   */
  getCapability(capability: string, version?: string): CapabilityDefinition | undefined {
    if (version !== undefined && version !== "") {
      return this.byKey.get(this.key(capability, version));
    }
    const versions = this.versionsByCapability.get(capability);
    const latest = pickLatestVersion(versions ?? []);
    if (!latest) return undefined;
    return this.byKey.get(this.key(capability, latest));
  }

  /** Exact version only; no implicit latest. */
  getCapabilityExact(capability: string, version: string): CapabilityDefinition | undefined {
    if (!version) return undefined;
    return this.byKey.get(this.key(capability, version));
  }

  listCapabilities(): CapabilityDefinition[] {
    return [...this.byKey.values()];
  }

  /**
   * Resolved definition for execution: pins `definition.version` as the canonical string for the wire.
   */
  resolveDefinitionForExecution(
    capability: string,
    versionHint?: string
  ): { definition: CapabilityDefinition; version: string } | undefined {
    const def = this.getCapability(capability, versionHint);
    if (!def) return undefined;
    return { definition: def, version: def.version };
  }

  lookupAdapterBinding(
    capability: string,
    versionHint?: string
  ): CapabilityDefinition["adapter"] | undefined {
    return this.resolveDefinitionForExecution(capability, versionHint)?.definition.adapter;
  }

  /**
   * Validate host-side only. Unknown capability → invalid (blocked before ZAKAI).
   * Order: JSON Schema (Ajv) → optional semantic validator.
   */
  validateInput(capability: string, input: unknown, version?: string): ValidationResult {
    const def = this.getCapability(capability, version);
    if (!def) {
      return {
        valid: false,
        errors: [{ message: `unknown capability or version: ${capability}${version ? `@${version}` : ""}` }],
      };
    }
    const { valid, errors } = validateAgainstSchema(capability, def.version, input);
    if (!valid && errors === null) {
      return {
        valid: false,
        errors: [{ message: "schema compiler missing (internal error)" }],
      };
    }
    if (!valid) {
      return { valid: false, errors: ajvErrorsToItems(errors) satisfies ValidationErrorItem[] };
    }
    const sem = this.semanticByKey.get(this.key(capability, def.version));
    if (sem) {
      const sr = sem(input);
      if (!sr.valid) {
        const errList = (sr.errors ?? ["semantic validation failed"]).map((m) => ({ message: m }));
        return { valid: false, errors: errList };
      }
    }
    return { valid: true };
  }

  /** @deprecated Use resolveDefinitionForExecution + pinned ZakIdeBridgeRequest.capability_version */
  resolveVersion(capability: string, version?: string): string | undefined {
    return this.resolveDefinitionForExecution(capability, version)?.version;
  }

  private key(capability: string, version: string): string {
    return `${capability}@${version}`;
  }
}
