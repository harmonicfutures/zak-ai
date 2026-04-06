import { CapabilityDefinition } from '@zak/capability-registry';

/** Bumped when compiler output shape or rules change materially. */
declare const COMPILER_VERSION = "0.1.0";
/** Must match docs/CAPABILITY_DEFINITION_TEMPLATE.md template_version when semantics align. */
declare const TEMPLATE_VERSION = "1.2.1";

type ExecClass = "A" | "B" | "C";
type Authority = "none" | "standard" | "elevated" | "continuous_resonance_required";
interface ValidatedWorksheet {
    capability: string;
    version: string;
    adapter: {
        key: string;
        route: string;
    };
    execution_class: ExecClass;
    authority_requirements: Authority;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    golden: {
        input: Record<string, unknown>;
        output?: unknown;
    };
    description?: string;
    tags?: string[];
    side_effect_tier?: "low" | "medium" | "irreversible";
    idempotency?: "none" | "keyed" | "inherent";
    replay_behavior?: "blocked" | "allowed_same_key" | "allowed_read_only_subset";
    async_model?: "poll" | "callback" | "poll_or_callback";
    job_id_field?: string;
    partial_receipt?: boolean;
}
declare function validateWorksheet(raw: unknown): {
    ok: true;
    ws: ValidatedWorksheet;
} | {
    ok: false;
    errors: string[];
};

/** Registry record only — fields that participate in `computeCapabilityDefinitionHash`. */
declare function worksheetToCapabilityDefinition(ws: ValidatedWorksheet): CapabilityDefinition;

interface CompileOptions {
    /** Parent directory of per-capability folders. */
    outBase: string;
    /**
     * When true, emit to `<outBase>/<capability>/<version>/` (multi-version capabilities).
     * When false, emit to `<outBase>/<capability>/` (single-version).
     */
    nestedVersionLayout?: boolean;
}
declare function parseWorksheetYaml(text: string): unknown;
declare function compileWorksheetFile(worksheetPath: string, options: CompileOptions): void;
/** Verify every definition.json under flat or `<cap>/<semver>/` layout. */
declare function verifyCompiledCapabilities(outBase: string): void;

declare function generateTestSpec(ws: ValidatedWorksheet): string;

declare function buildMeta(ws: ValidatedWorksheet): Record<string, unknown>;

export { COMPILER_VERSION, type CompileOptions, TEMPLATE_VERSION, type ValidatedWorksheet, buildMeta, compileWorksheetFile, generateTestSpec, parseWorksheetYaml, validateWorksheet, verifyCompiledCapabilities, worksheetToCapabilityDefinition };
