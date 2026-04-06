import type { IncomingHttpHeaders } from "http";
import { randomUUID } from "crypto";
import type { KernelRuntime, KernelResult, ExecutionEnvelope } from "../../contracts/kernel";
import type { ZakAuditEvent } from "../../contracts/audit";
import { parseAmount } from "../../utils/money";

export interface ZakHttpInput {
  intentId: string;
  payload: unknown;
  correlationId: string;
}

export interface ZakHttpOutput {
  status: number;
  body: KernelResult | { error: string };
  headers: Record<string, string>;
}

export class HttpZakAdapter {
  constructor(
    private readonly kernel: KernelRuntime,
    private readonly adapterId = "http-pilot-v1"
  ) {}

  /**
   * Ingest: Validate headers, generate correlation ID, sanitize body.
   */
  public ingest(headers: IncomingHttpHeaders, body: unknown): ZakHttpInput {
    const correlationId = this.resolveCorrelationId(headers);
    this.logEvent("INGESTED", correlationId);

    try {
      if (!body || typeof body !== "object") {
        throw new Error("Invalid payload: Body must be a JSON object");
      }

      // Check for monetary fields (recursive check could be added here, 
      // but for pilot we assume a flat 'amount' field often exists)
      const payload = body as Record<string, unknown>;
      if ('amount' in payload) {
         // This throws if 'amount' is a number
         parseAmount(payload['amount']); 
      }

      // Ensure intentId exists
      if (!payload.intentId || typeof payload.intentId !== "string") {
          throw new Error("Missing required field: intentId");
      }

      return {
        intentId: payload.intentId,
        payload: payload,
        correlationId
      };

    } catch (err: unknown) {
      this.logEvent("REJECTED", correlationId, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Execute: Bridge to Kernel.
   */
  public async execute(input: ZakHttpInput): Promise<KernelResult> {
    const startTime = Date.now();
    try {
      const envelope: ExecutionEnvelope = {
        intentId: input.intentId,
        payload: input.payload
      };

      const result = await this.kernel.execute(envelope);
      
      this.logEvent("EXECUTED", input.correlationId, { 
          durationMs: Date.now() - startTime,
          outcome: result.outcome 
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logEvent("REJECTED", input.correlationId, { 
          durationMs: Date.now() - startTime,
          error: errorMsg
      });
      throw err;
    }
  }

  /**
   * Emit: Format HTTP response.
   */
  public emit(correlationId: string, result: KernelResult): ZakHttpOutput {
    this.logEvent("EMITTED", correlationId, { outcome: result.outcome });

    const status = result.outcome === "success" ? 200 : 
                   result.outcome === "denied" ? 403 : 
                   result.outcome === "timeout" ? 408 : 500;

    return {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
        "X-ZAK-Adapter": this.adapterId
      },
      body: result
    };
  }

  /**
   * Resolve Correlation ID from headers or generate new.
   */
  private resolveCorrelationId(headers: IncomingHttpHeaders): string {
    const existing = headers["x-correlation-id"];
    if (Array.isArray(existing)) return existing[0];
    if (existing) return existing;
    return randomUUID();
  }

  /**
   * Structured logging to stdout.
   */
  private logEvent(
      event: ZakAuditEvent["event"], 
      correlationId: string, 
      extras?: Partial<Omit<ZakAuditEvent, "event" | "correlationId" | "adapterId" | "timestamp">>
  ) {
    const logEntry: ZakAuditEvent = {
      timestamp: new Date().toISOString(),
      adapterId: this.adapterId,
      correlationId,
      event,
      ...extras
    };
    process.stdout.write(JSON.stringify(logEntry) + "\n");
  }
}

