import { LLMEngineAdapter } from "../kernel/runner";

type LlamaCppModel = {
  tokenize(text: string): number[];
  generate(options: {
    prompt: string;
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    max_tokens?: number;
    stop?: string[];
    logit_bias?: Record<number, number>;
    grammar?: string;
  }): Promise<{ text: string; tokens_used: number }>;
};

export class LlamaCppAdapter implements LLMEngineAdapter {
  private model: LlamaCppModel;

  constructor(model: LlamaCppModel) {
    this.model = model;
  }

  async tokenize(text: string): Promise<number[]> {
    return this.model.tokenize(text);
  }

  async generate(prompt: string, options: any) {
    const result = await this.model.generate({
      prompt,
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      repeat_penalty: options.repeat_penalty,
      max_tokens: options.max_tokens,
      stop: options.stop,
      logit_bias: options.logit_bias,
      grammar: options.grammar
    });

    return {
      text: result.text,
      usage: {
        input: 0,          // Optional: fill if tokenizer supports it
        output: result.tokens_used
      }
    };
  }
}

