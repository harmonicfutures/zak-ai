export type MonetaryValue =
  | { kind: "decimal"; value: string }
  | { kind: "minor"; value: bigint };

export interface ExecutionEnvelope<I = unknown, O = unknown> {
  // Pure contract - no runtime implementation here
  intentId: string;
  payload: I;
}

export interface KernelResult<O = unknown> {
  outcome: "success" | "denied" | "interrupted" | "timeout";
  digest?: {
      nonceHash: string;
      routePlanHash?: string;
  };
  output?: O;
  error?: string;
}

export interface KernelRuntime {
  execute<I, O>(envelope: ExecutionEnvelope<I, O>): Promise<KernelResult<O>>;
}

