# ZAKAI

Constitutional execution substrate.

**Tooling requires Node.js 18+** (20 LTS recommended). Node 10/12 will fail on `import`, `tsup`, and `openai`. Use [nvm](https://github.com/nvm-sh/nvm): `nvm install` / `nvm use` (see `.nvmrc`).

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

For the **browser harness**, you can use **OpenRouter**: set `OPENROUTER_API_KEY` in **`ZAKAI/.env`** or **`draft-test-harness/.env`** (the harness file overrides on conflicts). See `draft-test-harness/sample.env`.

### Browser test harness (`draft-test-harness/`)

Same pipeline with a **dumb** HTML UI: `POST /generate` runs the model, then **`prepareExecutionRequest`**. Open **`http://localhost:3000`** after starting the server (served from `public/` — no `file://` CORS issues). **`/agent.html`** runs the pre-ZAK execution loop (strict decision JSON + fake `echo` tool).

```bash
export OPENAI_API_KEY="…"
cd capability-registry && npm run build
cd ../draft-test-harness && npm install && npm start
```

`POST /admit` is a **501 stub** until a real membrane client is wired.
