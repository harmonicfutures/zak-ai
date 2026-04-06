import { ExecutionManifest } from "./compiler";

export interface LLMEngineAdapter {
  tokenize(text: string): Promise<number[]>;
  generate(prompt: string, options: ExecutionManifest["engine"]): Promise<{ text: string; usage: any }>;
}

export interface RunnerResult {
  ok: boolean;
  result?: string;
  refusal?: string;
  audit: {
    correlationId: string;
    timestamp: number;
    duration_ms: number;
    gates: ExecutionManifest["io_gates"];
    actions: string[];
  };
}

export class ZAKRunner {
  static async execute(
    adapter: LLMEngineAdapter,
    manifest: ExecutionManifest,
    prompt: string,
    correlationId: string,
  ): Promise<RunnerResult> {
    const startTime = Date.now();
    const actions: string[] = ["START_EXECUTION"];

    try {
      // 1. Logit Bias Translation (Phrases -> Token IDs)
      const engineOptions = { ...manifest.engine };
      if (manifest.engine.logit_bias) {
        const translatedBias: Record<string, number> = {};
        for (const [phrase, bias] of Object.entries(manifest.engine.logit_bias)) {
          const tokens = await adapter.tokenize(phrase);
          for (const token of tokens) {
            translatedBias[token.toString()] = bias;
          }
        }
        engineOptions.logit_bias = translatedBias;
        actions.push("LOGIT_BIAS_TRANSLATED");
      }

      // 2. Generation
      const response = await adapter.generate(prompt, engineOptions);
      let outputText = response.text;
      actions.push("GENERATION_COMPLETE");

      // 3. Post-Processing: JSON Enforcement
      if (manifest.io_gates.response_format === "json_object") {
        try {
          JSON.parse(outputText);
          actions.push("JSON_VALIDATED");
        } catch (e) {
          actions.push("JSON_PARSE_FIRST_PASS_FAILED");
          
          // Single deterministic repair attempt (substring {} only)
          const start = outputText.indexOf("{");
          const end = outputText.lastIndexOf("}");
          
          if (start !== -1 && end !== -1 && end > start) {
            const potentialJson = outputText.substring(start, end + 1);
            try {
              JSON.parse(potentialJson);
              outputText = potentialJson;
              actions.push("JSON_REPAIRED_VIA_SUBSTRING");
            } catch (innerError) {
              return this.fail("JSON_REPAIR_FAILED", correlationId, startTime, manifest, actions);
            }
          } else {
            return this.fail("JSON_STRUCTURE_NOT_FOUND", correlationId, startTime, manifest, actions);
          }
        }
      }

      // 4. Post-Processing: Word Limit Truncation (hard slice)
      // Compiler derives max_tokens as words * 1.3. We enforce a hard word slice here.
      if (manifest.engine.max_tokens) {
        const wordLimit = Math.floor(manifest.engine.max_tokens / 1.3);
        const words = outputText.trim().split(/\s+/);
        if (words.length > wordLimit) {
          outputText = words.slice(0, wordLimit).join(" ");
          actions.push(`WORD_LIMIT_ENFORCED_AT_${wordLimit}`);
        }
      }

      const result: RunnerResult = {
        ok: true,
        result: outputText,
        audit: {
          correlationId,
          timestamp: Date.now(),
          duration_ms: Date.now() - startTime,
          gates: manifest.io_gates,
          actions,
        },
      };

      process.stdout.write(JSON.stringify(result.audit) + "\n");
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.fail(`RUNTIME_ERROR: ${errorMsg}`, correlationId, startTime, manifest, actions);
    }
  }

  private static fail(
    reason: string,
    correlationId: string,
    startTime: number,
    manifest: ExecutionManifest,
    actions: string[],
  ): RunnerResult {
    actions.push(`FAILURE: ${reason}`);
    const audit = {
      correlationId,
      timestamp: Date.now(),
      duration_ms: Date.now() - startTime,
      gates: manifest.io_gates,
      actions,
    };
    
    process.stdout.write(JSON.stringify(audit) + "\n");
    
    return {
      ok: false,
      refusal: "Execution refused: protocol or security violation.",
      audit,
    };
  }
}

