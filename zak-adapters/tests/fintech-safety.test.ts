import { describe, it, expect } from "vitest";
import { HttpZakAdapter } from "../src/adapters/http/adapter";
import type { KernelRuntime, ExecutionEnvelope, KernelResult } from "../src/contracts/kernel";

// 1. Mock Kernel (We don't need real execution, just the interface)
const mockKernel: KernelRuntime = {
  execute: async <I, O>(envelope: ExecutionEnvelope<I, O>): Promise<KernelResult<O>> => {
    return { outcome: "success" };
  }
};

// 2. Setup Adapter
const adapter = new HttpZakAdapter(mockKernel);
const MOCK_HEADERS = { "x-correlation-id": "test-c72b-442a" };

describe("Fintech Safety & Compliance Certificate", () => {
  
  describe("Rule 1: Strict Float Rejection", () => {
    it("MUST reject floating-point numbers at ingress (The Float Attack)", () => {
      const dangerousPayload = {
        intentId: "test-1",
        amount: 10.50 // DANGER: JavaScript number
      };

      expect(() => {
        adapter.ingest(MOCK_HEADERS, dangerousPayload);
      }).toThrow(/floats not permitted/);
    });

    it("MUST reject integer numbers at ingress (Strict Type Safety)", () => {
      const dangerousInteger = {
        intentId: "test-2",
        amount: 100 // Still a 'number' in JS, rejected to enforce uniformity
      };

      expect(() => {
        adapter.ingest(MOCK_HEADERS, dangerousInteger);
      }).toThrow(/floats not permitted/);
    });
  });

  describe("Rule 2: Allowed Representations", () => {
    it("MUST accept string decimals (The Safe String)", () => {
      const safePayload = {
        intentId: "test-3",
        amount: "10.50"
      };

      const result = adapter.ingest(MOCK_HEADERS, safePayload);
      expect(result.payload).toEqual(safePayload);
      expect(result.correlationId).toBe("test-c72b-442a");
    });

    it("MUST accept BigInt minor units (The BigInt Bypass)", () => {
      const bigIntPayload = {
        intentId: "test-4",
        amount: 1050n // Native BigInt
      };

      const result = adapter.ingest(MOCK_HEADERS, bigIntPayload);
      expect(result.payload).toEqual(bigIntPayload);
    });
  });

  describe("Rule 3: Structural Integrity", () => {
    it("MUST reject malformed currency strings", () => {
      const badString = {
        intentId: "test-5",
        amount: "TEN DOLLARS"
      };

      expect(() => {
        adapter.ingest(MOCK_HEADERS, badString);
      }).toThrow(/string must be numeric decimal/);
    });

    it("MUST reject missing intentId", () => {
      const incomplete = {
        amount: "10.00"
      };

      expect(() => {
        adapter.ingest(MOCK_HEADERS, incomplete);
      }).toThrow(/Missing required field: intentId/);
    });
  });
});

