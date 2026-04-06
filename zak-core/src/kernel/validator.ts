import { createHash } from "crypto";

export type Vector3 = [number, number, number];

export interface Sigil {
  meta: {
    id: string;
    version: number;
    author_signature: string;
    content_hash: string;
    created_at: number;
  };
  body: {
    geometry: {
      topology: "closed" | "open" | "porous" | "directed";
      complexity_weight: number;
      vectors: Vector3[];
    };
    material: {
      roughness: number;
      luminosity: number;
    };
    resonance: {
      base_frequency: number;
      amplitude: number;
      dissonance_frequencies: number[];
    };
    field_effect: {
      scope: "global" | "local";
      invariants: string[];
      directives: string[];
    };
  };
}

// --- CONSTANTS (THE LAW) ---
const MAX_VECTORS = 8;
const MAX_VECTOR_MAGNITUDE = 1.0001;

const ALLOWED_TOPOLOGIES = new Set([
  "closed",
  "open",
  "porous",
  "directed"
]);

const INVARIANT_REGISTRY = new Set([
  "OUTPUT_LIMIT_WORDS",
  "REFUSE_EXTERNAL_TOOLS",
  "REFUSE_PERSONAL_OPINION",
  "STRICT_FORMAT_JSON",
  "STRICT_FORMAT_MARKDOWN"
]);

const BAND_LIMITS = {
  SAFETY: { max: 100, ceiling: 1.0 },
  TONAL: { max: 500, ceiling: 0.8 },
  DOMAIN: { max: 1000, ceiling: 0.6 }
};

export class ZAKValidator {

  static validate(sigil: Sigil): { valid: boolean; reason?: string } {

    // 1. Integrity
    const computed = this.computeCanonicalHash(sigil.body);
    if (computed !== sigil.meta.content_hash) {
      return {
        valid: false,
        reason: `Hash mismatch: ${computed} != ${sigil.meta.content_hash}`
      };
    }

    // 2. Geometry
    const { vectors, topology } = sigil.body.geometry;

    if (!ALLOWED_TOPOLOGIES.has(topology)) {
      return { valid: false, reason: `Invalid topology ${topology}` };
    }

    if (vectors.length > MAX_VECTORS) {
      return { valid: false, reason: `Too many vectors` };
    }

    for (const [x, y, z] of vectors) {
      const mag = Math.sqrt(x * x + y * y + z * z);
      if (mag > MAX_VECTOR_MAGNITUDE) {
        return { valid: false, reason: `Vector magnitude overflow` };
      }
    }

    // 3. Resonance
    const { base_frequency, amplitude } = sigil.body.resonance;

    let ceiling: number;
    if (base_frequency <= BAND_LIMITS.SAFETY.max) {
      ceiling = BAND_LIMITS.SAFETY.ceiling;
    } else if (base_frequency <= BAND_LIMITS.TONAL.max) {
      ceiling = BAND_LIMITS.TONAL.ceiling;
    } else {
      ceiling = BAND_LIMITS.DOMAIN.ceiling;
    }

    if (amplitude > ceiling) {
      return { valid: false, reason: `Amplitude exceeds band ceiling` };
    }

    // 4. Invariants
    for (const inv of sigil.body.field_effect.invariants) {
      const key = inv.split(":")[0];
      if (!INVARIANT_REGISTRY.has(key)) {
        return { valid: false, reason: `Unknown invariant ${key}` };
      }
    }

    return { valid: true };
  }

  private static canonicalStringify(obj: any): string {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return "[" + obj.map(v => this.canonicalStringify(v)).join(",") + "]";
    }
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(
      k => `"${k}":${this.canonicalStringify(obj[k])}`
    ).join(",") + "}";
  }

  static computeCanonicalHash(body: any): string {
    const json = this.canonicalStringify(body);
    return createHash("sha256").update(json).digest("hex");
  }
}

