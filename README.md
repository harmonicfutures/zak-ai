# ZAKAI

Constitutional execution substrate.

## Core model

- ZAKAI: stateless execution
- Proxy: admission + enforcement
- Registry (host): capability definitions, validation, semantics
- Snapshot: admissible (capability, version) pairs + optional pinned definition hashes

## Invariants

- capability_definition_hash is host-asserted; membrane MUST NOT recompute
- capability_version is required at admission
- snapshot is a whitelist artifact, not a registry
- hash algorithm identity is versioned via `v`

## Modes

- observability: hash recorded
- enforced_pinned: hash compared to snapshot pin (fail closed)

## Philosophy

Separation of:

- meaning (host)
- admissibility (snapshot)
- execution (ZAKAI)
- enforcement (proxy)
