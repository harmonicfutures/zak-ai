This matrix is normative. Any behavior not explicitly assigned is considered prohibited by default.

# Kernel–Adapter Responsibility Matrix

| Responsibility Domain | Adapter Layer (`zak-adapters`) | Kernel / Recipient | Explicitly Out of Scope |
| :--- | :--- | :--- | :--- |
| **Protocol decoding** | ✅ Translates wire formats into `ExecutionEnvelope` | ❌ | ❌ |
| **Structural validation** | ✅ Enforces object shape, required fields | ❌ | ❌ |
| **Type safety (monetary)** | ✅ Rejects JS number / float inputs | ❌ | ❌ |
| **Semantic validation** | ❌ | ✅ | ❌ |
| **Business rules** | ❌ | ✅ | ❌ |
| **Authority / approval** | ❌ | ✅ | ❌ |
| **Envelope mutation** | ❌ (read-only) | ❌ (immutable) | ❌ |
| **Execution decision** | ❌ | ✅ | ❌ |
| **Persistence** | ❌ | ❌ (explicitly opt-in only) | ❌ |
| **Authentication** | ❌ (identity carried only) | ❌ / delegated | ✅ Upstream |
| **Authorization** | ❌ | ✅ | ❌ |
| **Rate limiting** | ❌ | ❌ | ✅ Upstream |
| **DDoS / flood mitigation** | ✅ (structural early-drop only) | ❌ | ❌ |
| **Deep packet inspection** | ❌ | ❌ | ✅ |
| **Cryptography / TLS** | ❌ | ❌ | ✅ Upstream |
| **Logging (ingress)** | ✅ | ❌ | ❌ |
| **Logging (execution outcome)** | ❌ | ✅ | ❌ |
| **Error normalization** | ✅ (transport-level) | ❌ | ❌ |
| **Determinism guarantees** | ❌ | ✅ | ❌ |
| **State & Logic invariants** | ❌ | ✅ | ❌ |
