# Capability Definition Hash Enforcement (Draft)

## Goal

Allow policy layer to require `capability_definition_hash` presence for selected capabilities.

## Non-Goals

- No membrane recompute of definition hash
- No expansion of snapshot into a registry
- No change to existing observability mode behavior

## Current State

- `capability_definition_hash` is optional on the wire
- Membrane records and optionally compares to snapshot pins
- Absence is allowed uniformly

## Proposed Direction

Introduce policy-layer control:

- For selected (capability, version):
  - Require `capability_definition_hash` to be present
  - Reject if absent (fail-closed)
  - Continue existing pin comparison behavior if pins exist

## Constraints

- Host remains sole source of definition identity
- Membrane remains identity checker, not definition resolver
- No capability-specific semantic branching beyond policy

## Open Questions

- How policy selects capabilities (explicit list vs pattern)
- Interaction with mixed rollout (observability vs enforced_pinned)
- Whether enforcement is version-scoped or capability-wide

## Invariants

- No recompute at membrane
- No change to absent/present semantics outside policy requirement
- No snapshot semantic expansion

## Status

Draft
