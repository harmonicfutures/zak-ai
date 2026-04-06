## Invariant Check (required)

- [ ] Does this change affect capability_definition_hash semantics?
- [ ] Does this change alter absent vs present behavior at the membrane?
- [ ] Does this change introduce new fields or meaning into capability_snapshot?
- [ ] Does this modify canonicalization without bumping `v`?

If ANY answer is yes:

- This is a protocol-level change, not a refactor.
- Explain the break explicitly.
