## Invariant Check (required)

- [ ] Does this change affect capability_definition_hash semantics?
- [ ] Does this change alter absent vs present behavior at the membrane?
- [ ] Does this change introduce new fields or meaning into capability_snapshot?
- [ ] Does this modify canonicalization without bumping `v`?
- [ ] Does this alter compiler output shape or compiled capability loading behavior?
- [ ] Does this change `executeGovernedCapability(...)` success/failure stage semantics?
- [ ] Does this change durable receipt fields, hashing, chaining, or replay behavior?
- [ ] Does this weaken authority provenance, startup blockers, or fail-closed governance invariants?

If ANY answer is yes:

- This is a protocol-level change, not a refactor.
- Explain the break explicitly.
