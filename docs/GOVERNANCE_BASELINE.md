# Governance Baseline

This document defines the frozen governance baseline for ZAKAI before any ZAK IDE transplant work.

## Gold Standard

Baseline means production-grade fail-closed governance.

Gold Standard adds:
- separately verifiable receipt integrity through checkpoint anchors
- authority resolved inside governed admission from request context plus runtime state
- explicit idempotency-aware replay policy for Class B
- deterministic governance self-health reporting
- proof at the final response boundary that unvalidated output cannot be surfaced as governed success

## Frozen Contract

- `capability_definition_hash` semantics are unchanged.
- Compiler outputs remain `definition.json`, `definition.hash`, `meta.json`, normalized worksheet, and generated tests.
- `executeGovernedCapability(...)` is the single governed runtime path.
- Successful governed execution remains terminal `stage: "executed"`.
- Class A/B/C enforcement remains fail-closed.

## Governance Checklist

Status meanings:
- `Verified`: enforced in code and covered by tests.
- `Open`: not yet complete enough for baseline lock.

| Invariant | Status | Evidence |
| --- | --- | --- |
| Compiled meta must exist and satisfy Class A/B/C policy invariants | Verified | `capability-registry/src/index.ts`, `capability-registry/test/enforcement.test.ts` |
| Output schema must be present for governed capabilities | Verified | `capability-registry/src/capability-meta.ts`, `capability-registry/test/load-disk.test.ts` |
| Admission requires provenance-backed authority context | Verified | `capability-registry/src/enforcement.ts`, `capability-registry/test/enforcement.test.ts`, `capability-registry/test/governed-execution.test.ts` |
| Durable governance runtime is required for replay-blocked execution | Verified | `capability-registry/src/bridge.ts`, `capability-registry/src/enforcement.ts`, `capability-registry/test/governed-execution.test.ts` |
| Success and failure receipts persist durably when the store is available | Verified | `capability-registry/src/governed-execution.ts`, `capability-registry/test/governed-execution.test.ts` |
| Receipt persistence failure fails closed after execution | Verified | `capability-registry/src/governed-execution.ts`, `capability-registry/test/governed-execution.test.ts` |
| Receipt chain uses deterministic canonical hashing with continuity links | Verified | `capability-registry/src/governance-runtime.ts`, `capability-registry/test/governed-execution.test.ts` |
| Receipt anchors provide a second verifiable integrity path | Verified | `capability-registry/src/governance-runtime.ts`, `capability-registry/test/governance-runtime.test.ts` |
| Corrupt or tampered receipt state is a startup blocker | Verified | `capability-registry/src/governance-runtime.ts`, `capability-registry/test/governance-runtime.test.ts` |
| Replay blocking survives restart/process boundary | Verified | `capability-registry/src/governance-runtime.ts`, `capability-registry/test/governed-execution.test.ts` |
| `allowed_same_key` replay is explicit and tied to keyed idempotency | Verified | `capability-registry/src/enforcement.ts`, `capability-registry/test/governed-execution.test.ts` |
| Harness success responses represent completed governed execution and include `request`, `adapter`, `output`, `receipt` | Verified | `draft-test-harness/server.js`, `draft-test-harness/test/governed-response-contract.test.mjs` |
| Governance can self-report deterministic pass/fail health | Verified | `capability-registry/src/index.ts`, `capability-registry/test/governance-runtime.test.ts`, `draft-test-harness/server.js` |
| Governed success output cannot cross the harness response boundary without validated receipt state | Verified | `draft-test-harness/lib/governed-response.mjs`, `draft-test-harness/test/governed-response-contract.test.mjs` |
| Inspection surfaces are read-only and derived from durable runtime state | Verified | `draft-test-harness/server.js` |
| Any remaining optional/bypassable governance path exists outside `executeGovernedCapability` | Open | Audit expectation: do not introduce any |

## Startup vs Execution Blockers

Startup blockers:
- missing or invalid compiled governance meta
- missing output schema for governed capability metadata
- unavailable receipt store root / journal
- corrupt receipt journal
- broken receipt chain at startup
- broken receipt anchors at startup
- replay ledger inconsistency at startup

Execution blockers:
- definition resolution failure
- input validation failure
- authority provenance failure
- authority insufficiency
- replay-blocked Class B admission
- adapter failure
- output validation failure
- receipt persistence failure

## Coverage Report

### What is tested

- Request/input contract enforcement across compiled capabilities and semantic validators.
- Output contract enforcement for governed execution and direct output validation helpers.
- Meta/policy enforcement for Class A/B/C and authority requirements.
- Durable receipt persistence for success and failure paths.
- Receipt chain continuity and tamper detection.
- Receipt anchor integrity and anchor mismatch detection.
- Durable replay behavior across restart.
- Idempotency-aware replay admission for `allowed_same_key`.
- Corrupt governance state startup failures.
- Compiled artifact drift and misalignment cases: hash mismatch, mixed layouts, folder/version mismatch, invalid meta.
- Harness response contract for governed success/failure payloads.
- Governance health reporting and output-validation boundary assertions.

### Failure classes covered

- schema-invalid input
- semantic-invalid input
- missing / malformed governance metadata
- malformed authority provenance
- forged authority seed overridden by request-context resolution
- insufficient authority
- duplicate replay for replay-blocked Class B
- idempotency-key reuse with different input
- invalid adapter output
- adapter invocation failure
- receipt persistence failure
- receipt-chain corruption
- receipt-anchor corruption
- corrupt receipt journal on startup
- compiled artifact layout/version/meta mismatches

### Assumptions

- Durable governance state is file-backed on a trusted host filesystem.
- Receipt-chain continuity is maintained per `(environment, runtime, session, subject)` chain key.
- Receipt anchors are append-only file checkpoints, not third-party notarization.
- `executeGovernedCapability(...)` remains the single execution path for governed calls.
- Harness inspection routes are diagnostics, not product APIs.

### Open Risks

- File-backed durability does not yet provide multi-process locking semantics beyond append-only host behavior.
- Anchor checkpoints are locally verifiable but not yet notarized to an external trust system.
- Harness inspection surface is minimally tested through helpers and runtime assertions rather than full HTTP endpoint integration.

## Baseline Release Note

Recommended baseline tag: `zakai-governance-baseline-v1`.

Release intent:
- freeze capability hash semantics
- freeze compiler/governed-runtime contract
- freeze receipt/replay/authority invariants
- require new changes to declare protocol impact explicitly before merge
