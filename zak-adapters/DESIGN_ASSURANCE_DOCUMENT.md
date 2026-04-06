# Design Assurance Document (DAD)

**Project:** `zak-adapters`
**Artifact Type:** Formal Assurance Memo
**Status:** Canonical / Frozen

---

## 1. Attestation Statement

This document records a formal design assurance review of the `zak-adapters` repository. It certifies that the implemented boundaries, structural invariants, and responsibility divisions conform to the **Zero Asset Kernel (ZAK)** architectural requirements.

This review is based on the repository state at the current revision. It asserts that the components defined herein satisfy their transport and containment responsibilities without assuming or usurping the authority of the kernel.

**Limitations:** This attestation is strictly limited to the code and artifacts contained within this repository. It makes no representations regarding the security or correctness of external systems, including the upstream network environment or the downstream `zak-kernel`.

---

## 2. Scope of Review

The scope of this assurance memo is explicitly limited to:

1.  **TypeScript Adapter Layer:**
    *   `src/adapters/http` (Protocol translation and input ingest)
    *   `src/utils/money.ts` (Monetary type safety enforcement)
    *   `src/contracts` (Interface definitions)
2.  **Rust/eBPF Ingress Layer:**
    *   `zak-ingress-sentry` (XDP program and loader)
    *   `zak-core-logic` (Invariant verification logic)

**Excluded from Scope:**
*   `tests/` (Reviewed only where explicitly cited as evidence)
*   External `node_modules` or crate dependencies
*   Deployment infrastructure (Docker, CI/CD)

---

## 3. Core Invariants

The following invariants are asserted as fundamental to the system's safety and containment properties. These assertions rely on the definitions provided in the **Kernel–Adapter Responsibility Matrix** (`KERNEL_ADAPTER_RESPONSIBILITY_MATRIX.md`).

### 3.1. Authority Non-Escalation
The adapter layer is structurally incapable of authorizing execution or modifying system state. All outputs are advisory `ExecutionEnvelope` objects. The adapter cannot bypass kernel policy.

### 3.2. Structural & Type Safety
The adapter layer enforces strict structural validity and type safety for critical fields (specifically monetary values) prior to kernel ingress. Precision-unsafe types (JavaScript `number`) are rejected at the boundary.

### 3.3. Stateless Containment
The adapter components operate statelessly. No persistence or mutable state retention occurs within the adapter execution context.

---

## 4. Traceability Summary

All architectural and safety claims made in this document are mapped to concrete implementation evidence in the **Regulator Mapping Appendix** (`REGULATOR_MAPPING_APPENDIX.md`).

*   **Evidence of Safety:** See `REGULATOR_MAPPING_APPENDIX.md`, Rows 1-2.
*   **Evidence of Boundary:** See `REGULATOR_MAPPING_APPENDIX.md`, Rows 3-5.
*   **Evidence of Containment:** See `REGULATOR_MAPPING_APPENDIX.md`, Row 6.

No claim is made in this document that cannot be traced to a specific row in the Appendix or a clause in the **Kernel–Adapter Responsibility Matrix**.

---

## 5. Exclusions & Assumptions

The validity of this assurance memo relies on the following explicit exclusions and assumptions. Failure of these assumptions voids the assurance provided herein.

1.  **External Kernel Authority:** It is assumed that the downstream `KernelRuntime` is the sole authoritative entity for semantic validation, authorization, and state mutation. The adapter relies entirely on the kernel for these functions.
2.  **Upstream Transport Security:** It is assumed that Transport Layer Security (TLS) and initial connection authentication are handled by the upstream environment (e.g., Load Balancer, API Gateway). This repository implements no encryption primitives.
3.  **Hardware Dependencies (XDP):** The performance claims regarding `zak-ingress-sentry` (line-rate drop) assume a Network Interface Card (NIC) with native XDP offload support. In generic driver mode, performance characteristics will differ.
4.  **No Semantic Guarantees:** This review attests only to structural and type-level correctness. No claim is made regarding the semantic validity of the business intents passed through the adapter.

---

## 6. Conclusion

Based on the inspection of the artifacts, code, and responsibility matrices:

**Verdict:** The `zak-adapters` repository **satisfies its stated responsibilities** as a non-authoritative boundary layer.

It correctly implements the required isolation between ingress protocols and kernel authority, enforcing defined structural invariants without exceeding its architectural scope. No evidence was identified that contradicts the stated responsibility boundaries or invariants within the reviewed scope.
