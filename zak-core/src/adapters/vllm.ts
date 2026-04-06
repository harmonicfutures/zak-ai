import { LLMEngineAdapter } from "../kernel/runner";

export class VLLMAdapter implements LLMEngineAdapter {
  private endpoint: string;

  constructor(endpoint: string) {
    // Enforce local binding only. Rejects external IPs.
    const VLLM_HOST = process.env.VLLM_HOST || "127.0.0.1";
    if (VLLM_HOST !== "127.0.0.1" && VLLM_HOST !== "localhost") {
      throw new Error("SECURITY FAULT: Adapter configured for external interface.");
    }
    this.endpoint = endpoint;
  }

  async tokenize(text: string): Promise<number[]> {
    const res = await fetch(`${this.endpoint}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    if (!res.ok) {
      throw new Error("vLLM tokenize failed");
    }

    const json = (await res.json()) as { tokens: number[] };
    return json.tokens;
  }

  async generate(prompt: string, options: any) {
    const res = await fetch(`${this.endpoint}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...options
      })
    });

    if (!res.ok) {
      throw new Error("vLLM generate failed");
    }

    const json = (await res.json()) as {
      text: string;
      usage?: { input: number; output: number };
    };

    return {
      text: json.text,
      usage: {
        input: json.usage?.input ?? 0,
        output: json.usage?.output ?? 0
      }
    };
  }
}

