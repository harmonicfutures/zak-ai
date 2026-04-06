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

## Model-generated drafts (host only)

The LLM is an untrusted input source. A minimal pipeline lives at
`capability-registry/examples/openai-draft-pipeline/`: it calls the OpenAI **Responses** API with
`text.format: json_object`, parses output as hostile, then runs **`prepareExecutionRequest`** so only
registry validation + semantics decide accept/reject.

```bash
export OPENAI_API_KEY="…"
# optional: export OPENAI_MODEL=gpt-4o
cd capability-registry && npm run build && cd examples/openai-draft-pipeline && npm install && npm start
```
