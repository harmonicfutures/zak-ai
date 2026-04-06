# ZAK Adapters: Technical Implementation Report

**Repository:** `zak-adapters`
**Version:** Current HEAD
**Scope:** `src/adapters` (TypeScript) and `zak-ingress-sentry` (Rust/eBPF)

---

## 1. Repository Overview

### Purpose
This repository houses the **boundary infrastructure** for the Zero Asset Kernel (ZAK). It provides the mechanisms to transport external signals (HTTP requests, network packets) into the kernel's execution context.

### Problem Solved
1.  **Protocol Translation:** Converts wire formats (JSON/HTTP, raw Ethernet frames) into the uniform `ExecutionEnvelope` expected by the kernel.
2.  **Safety Filtering:** Enforces strict **structural and type-level invariants** at ingress to prevent malformed or **precision-unsafe** inputs from reaching the kernel.
3.  **High-Performance Ingress:** Provides a kernel-bypass mechanism (XDP) to filter signaling storms at line rate without instantiating protocol stacks.

### Non-Goals
*   **Business Logic:** No business rules or asset state management occur here.
*   **Persistence:** These adapters are stateless.
*   **Authentication:** Identity is carried but not verified here (deferred to Kernel).

---

## 2. Adapter Boundary Model

### Trust Boundary
The **Trust Boundary** is strictly defined at the `ingest` method of each adapter.
*   **External:** Network callers (HTTP clients, raw packet senders).
*   **Internal:** The `KernelRuntime` interface, treated as an external, authoritative execution service.

### Authority Non-Escalation
The adapter layer **cannot** elevate privileges, mint authority, or override kernel decisions. All adapter outputs are advisory inputs to the kernel runtime and carry no enforcement power independently.

### Components

#### A. HTTP Adapter (`src/adapters/http`)
*   **Inputs:** HTTP Headers, JSON Body.
*   **Accepted Payload:** Object with `intentId` (string) and optional `payload`.
*   **Monetary Safety:** Explicitly **REJECTS** JSON `number` types for monetary fields. Accepts `string` (decimal) or `BigInt` (minor units).
*   **Outputs:** Standardized JSON response with HTTP status codes.

#### B. Ingress Sentry (`zak-ingress-sentry`)
*   **Inputs:** Raw network packets via eBPF XDP hook.
*   **Accepted Payload:** Exactly **64 bytes** containing the Magic ID `0x5A414B00`.
*   **Outputs:** XDP Action Codes (`XDP_PASS`, `XDP_DROP`, `XDP_ABORTED`).

### State Retention
**None.** Both systems are fully stateless. Correlation IDs are generated if missing but not stored.

---

## 3. Execution Flow (Concrete)

### A. HTTP Request Flow
1.  **Entry:** `HttpZakAdapter.ingest(headers, body)`
2.  **Correlation:** Checks `X-Correlation-ID` header; generates UUID v4 if missing.
3.  **Structural Validation:**
    *   Asserts body is a JSON object.
    *   Asserts `intentId` exists.
    *   **Critical:** Calls `parseAmount` on `amount` field (if present). Throws on JS `number`.
4.  **Execution:** Wraps data in `ExecutionEnvelope` -> calls `kernel.execute()`.
5.  **Egress:** `HttpZakAdapter.emit()` maps kernel outcome:
    *   `success` -> 200 OK
    *   `denied` -> 403 Forbidden
    *   `timeout` -> 408 Request Timeout
    *   `interrupted` -> 500 Internal Server Error

### B. XDP Packet Flow
1.  **Entry:** `zak_ingress` (XDP Hook).
2.  **Parsing:** `try_zak_ingress` attempts extraction at two offsets:
    *   **UDP:** Offset 42 (Eth + IP + UDP).
    *   **Ethernet:** Offset 14 (Raw L2).
3.  **Invariant Logic:** Calls `zak_core_logic::analyze_packet()`.
    *   Check 1: Length == 64 bytes.
    *   Check 2: First 4 bytes == `0x5A414B00`.
4.  **Decision:**
    *   **Pass:** `XDP_PASS` (Packet continues to OS stack).
    *   **Fail:** `XDP_DROP` (Packet discarded immediately).

---

## 4. Safety & Containment Guarantees

### Enforced by Code
1.  **Floating Point Prevention:** `src/utils/money.ts` throws `Error("Invalid monetary type: floats not permitted")` if a JavaScript number is detected. This prevents precision loss attacks.
2.  **Zero-Allocation Ingress (Rust):** `zak-core-logic` is `no_std` and performs no heap allocations, guaranteeing predictable performance under load.
3.  **Strict Size Enforement:** `zak_core_logic` rejects any packet not exactly 64 bytes, mitigating buffer overflow risks at the logic layer.

### Failure Modes
*   **Validation Failure:** Immediate exception (TS) or `false` return (Rust). Logged as `REJECTED`.
*   **Kernel Failure:** Caught in `execute` block, logged, and returned as HTTP 500 or XDP Drop.
*   **Panic Safety:** The XDP program includes a panic handler suitable for `no_std` eBPF environments, minimizing undefined behavior rather than providing runtime recovery.

---

## 5. Threat Model

| Threat | Mitigation Mechanism | Implementation Location |
| :--- | :--- | :--- |
| **Floating Point Drift** | Strict type checking (`typeof input === "number"` triggers error). | `src/utils/money.ts` |
| **Signaling Storm (DDoS)** | Early XDP Drop before OS stack allocation. | `zak_ingress_sentry` |
| **Malformed Payloads** | Structural checks for `intentId` and JSON object. | `src/adapters/http/adapter.ts` |
| **Buffer Overflow** | Strict 64-byte slice length check. | `zak-core-logic/src/lib.rs` |

### Explicit Non-Goals
*   **Encryption:** The adapter does not perform TLS termination (assumed upstream).
*   **Deep Packet Inspection:** The XDP sentry only verifies the header magic; it does not validate the inner 60 bytes of the payload.

---

## 6. Protocol & Interface Specification

### HTTP Interface
*   **Format:** JSON
*   **Required Header:** `X-Correlation-ID` (Recommended)
*   **Required Body Field:** `intentId` (String)
*   **Restricted Body Field:** `amount` (Must be String or serialized BigInt, NEVER Number)

### Wire Interface (Sentry)
*   **Magic Header:** `0x5A 0x41 0x4B 0x00` (Bytes 0-3)
*   **Total Size:** 64 Bytes (Fixed)
*   **Transport:** Raw Ethernet or UDP Payload.

---

## 7. Operational Characteristics

*   **Statelessness:** No side effects are persisted within the adapter layer.
*   **Determinism:**
    *   `zak-core-logic` is a pure function.
    *   `parseAmount` is a pure function.
*   **Concurrency:**
    *   **HTTP:** Async/Non-blocking (Node.js Event Loop).
    *   **XDP:** Per-CPU execution (Kernel context).
*   **Performance:**
    *   XDP logic aims for **line-rate, sub-microsecond class rejection**.
    *   TS logic bench-marked for sub-millisecond overhead.

---

## 8. Test Coverage Analysis

### Tested Behaviors
*   **Fintech Safety (`tests/fintech-safety.test.ts`):**
    *   Rejection of `10.50` (float).
    *   Rejection of `100` (integer as number).
    *   Acceptance of `"10.50"` (string).
    *   Acceptance of `1050n` (BigInt).
*   **Core Logic (`zak-core-logic/src/lib.rs`):**
    *   Valid Magic/Size.
    *   Invalid Magic.
    *   Invalid Size.

### Gaps
*   **Recursive Validation:** The HTTP adapter currently only checks `amount` at the top level of the payload. Adapters intentionally avoid recursive payload inspection to prevent schema coupling and defer semantic validation to the kernel.
*   **XDP Integration:** The `zak-sentry-ebpf` binary is built but not automatically tested in a VM environment in this repo (requires privileged runner).

---

## 9. Known Limitations & Deliberate Trade-offs

1.  **Top-Level Validation Only:** The `HttpZakAdapter` assumes `amount` is a top-level property. Malformed numbers buried deep in a generic payload object will bypass the adapter's check and must be caught by the Kernel.
2.  **Hardcoded Offsets:** The XDP program looks for the payload at fixed offsets (14 and 42). It does not parse variable-length IP options or VLAN tags, meaning tagged traffic might be dropped incorrectly.

---

## 10. Audit Readiness Summary

### Verifiable in this Repo
*   [x] **Input Sanitization:** Code explicitly bans JavaScript numbers for money.
*   [x] **Invariant Logic:** The 64-byte/Magic-Header rule is hardcoded in Rust.
*   [x] **Audit Logging:** **Key ingress, execution, and rejection paths** emit structured logs.

### Requires Upstream Evidence
*   **Kernel Execution:** The kernel is mocked (`mockKernel`). Actual safe execution depends on the external `zak-kernel` repo.
*   **XDP Deployment:** The `zak-sentry-user` loader proves the program *can* load, but actual packet drop rates depend on NIC hardware offload capabilities.
