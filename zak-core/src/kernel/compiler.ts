import { Sigil } from "./validator";

export interface ExecutionManifest {
  engine: {
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    max_tokens?: number;
    logit_bias?: Record<string, number>;
  };
  io_gates: {
    allow_tools: boolean;
    allow_rag: boolean;
    response_format: "text" | "json_object";
  };
}

function materialPhysics(roughness: number): ExecutionManifest['engine'] {
  return {
    temperature: Math.max(0.1, +(1 - roughness * 0.9).toFixed(2)),
    repeat_penalty: +(1 + roughness * 0.2).toFixed(2),
    top_p: Math.max(0.5, +(1 - roughness * 0.5).toFixed(2)),
    top_k: Math.floor(100 - roughness * 80)
  };
}

export class ZAKCompiler {

  static compileContext(sigils: Sigil[], _query: string): ExecutionManifest {

    const sorted = [...sigils].sort((a, b) => {
      const band = (f: number) => f <= 100 ? 0 : f <= 500 ? 1 : 2;
      const d = band(a.body.resonance.base_frequency) - band(b.body.resonance.base_frequency);
      if (d !== 0) return d;
      if (b.body.resonance.amplitude !== a.body.resonance.amplitude) {
        return b.body.resonance.amplitude - a.body.resonance.amplitude;
      }
      if (a.meta.id < b.meta.id) return -1;
      if (a.meta.id > b.meta.id) return 1;
      return 0;
    });

    let maxRoughness = 0;
    let minWords = Infinity;
    let allowTools = true;
    let allowRag = true;
    let forceJson = false;
    const logit_bias: Record<string, number> = {};

    for (const s of sorted) {
      maxRoughness = Math.max(maxRoughness, s.body.material.roughness);

      const topo = s.body.geometry.topology;
      if (topo === "closed" || topo === "directed") {
        allowTools = false;
        allowRag = false;
      }
      if (topo === "directed") {
        forceJson = true;
      }

      for (const inv of s.body.field_effect.invariants) {
        const [key, param] = inv.split(":");
        if (key === "OUTPUT_LIMIT_WORDS" && param) {
          minWords = Math.min(minWords, parseInt(param, 10));
        }
        if (key === "REFUSE_PERSONAL_OPINION") {
          logit_bias["I think"] = -100;
          logit_bias["I feel"] = -100;
        }
      }
    }

    const engine = materialPhysics(maxRoughness);
    if (minWords !== Infinity) {
      engine.max_tokens = Math.ceil(minWords * 1.3);
    }
    if (Object.keys(logit_bias).length) {
      engine.logit_bias = logit_bias;
    }

    return {
      engine,
      io_gates: {
        allow_tools: allowTools,
        allow_rag: allowRag,
        response_format: forceJson ? "json_object" : "text"
      }
    };
  }
}

