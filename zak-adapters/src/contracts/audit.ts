export interface ZakAuditEvent {
  correlationId: string;
  adapterId: string;
  event: "INGESTED" | "EXECUTED" | "EMITTED" | "REJECTED";
  timestamp: string; // ISO 8601
  durationMs?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

