# Capability Definition Template

**Status:** Frozen normative spec for new capabilities. Treat as contract text, not guidance.  
**Audience:** Humans and tools that register host-side capabilities.  
**Non-goals:** Product narrative, UX copy, or motivational language.

**Bypass rule:** No capability may skip this template. “Quick” registrations without worksheet, golden test, and hash discipline are invalid until brought into conformance.

---

## 0. Document control

| Field | Value |
|--------|--------|
| Capability id | `<reverse-dnsCapability.id>` e.g. `hai.time.get` |
| Version | SemVer string e.g. `1.0.0` |
| Template revision | `2026-04-06` |
| Template version | `1.2.1` (bump only when this document’s required fields or semantics change) |
| Owner | `<team or role>` |

**Freeze:** `template_version` changes are breaking for process and tooling. Record the pair `(template_revision, template_version)` in registry metadata or release notes when you adopt a new template cut.

---

## 1. Required fields (registry record)

Each registered capability **must** supply the following. Omission is a registration error.

| Field | Type | Constraints |
|--------|------|-------------|
| `capability` | string | Stable id. No whitespace. Prefer `hai.*` / `zak.*` convention where applicable. |
| `version` | string | SemVer. Multiple versions may coexist under one `capability` id. |
| `adapter.key` | string | Adapter process or plugin identifier (e.g. `hai-adapter`). |
| `adapter.route` | string | Handler id within the adapter (e.g. `time.get`). |
| `input_schema` | object | JSON Schema (draft-07 compatible). Describes **`input`** only. |

Optional registry fields (allowed, not required):

- `description` — short text.
- `tags` — string array for discovery.
- `authority_requirements` — string enum (see **Section 1.2**). When present in code, admission **must** enforce it at the execution boundary. Until the type exists, record only in the worksheet and PR.

Source of truth in code: `CapabilityDefinition` in `capability-registry/src/types.ts`.

Until those types include execution-class and authority metadata, **document** both in the worksheet (YAML or Section 10 sketch) and PR description; add fields to the type when you enforce them in CI.

---

## 1.1 Execution class (required)

Every capability **must** declare exactly one primary class. If behavior spans classes (e.g. starts async, ends with a read), split into separate capabilities or document the primary class and list secondary behaviors under “Notes.”

### Class A — Pure read

- **Examples:** `hai.time.get`, `system.status.get`
- **Mutates external state:** no
- **Default replay:** replays are safe if inputs are identical (still subject to membrane and policy)
- **Worksheet:** `Execution class: A`

### Class B — Mutating

- **Examples:** `file.write`, `email.send`, physical actuators
- **Mutates external state:** yes
- **Required worksheet fields:**
  - `side_effect_tier`: `low` | `medium` | `irreversible` (define each tier in your org glossary; `irreversible` demands strongest approval pathway)
  - `idempotency`: `none` | `keyed` | `inherent` (if `keyed`, specify where the idempotency key lives: input field name or header contract)
  - `replay_behavior`: `blocked` | `allowed_same_key` | `allowed_read_only_subse
  t` (document what “subset” means for this capability)
- **Adapter obligation:** document observable effect and any deduplication semantics; host policy may reject duplicate replays

### Class C — Long-running / asynchronous

- **Examples:** workflows, deployments, multi-step agents
- **Synchronous completion:** not assumed; initial call may return a handle only
- **Required worksheet fields (when Class C):**
  - `async_model`: `poll` | `callback` | `poll_or_callback` (reference host contract for callbacks)
  - `job_id_field`: name of the stable job / operation id in responses (or `input` field that names the correlation id)
  - `partial_receipt`: yes/no; if yes, list intermediate states the host or adapter may emit
- **First request → result → done** remains valid for Class A and for Class B when you explicitly design synchronous completion; Class C **must not** pretend to be single-shot without documenting the handle and terminal states

**Worksheet:** `Execution class: A | B | C` plus the fields above for B and C.

---

## 1.2 Authority requirements (required on worksheet)

Each capability **must** declare what the **caller** (session, principal, or continuity signal—host-defined) must satisfy for admission **in addition to** schema, membrane whitelist, and execution class. This is not login UI policy; it is **execution-boundary** demand on the sealed request path.

| Value | Meaning (normative labels; refine in host policy docs) |
|--------|----------------------------------------------------------|
| `none` | No extra authority beyond baseline admitted execution for this constitution / membrane. |
| `standard` | Default elevated checks for sensitive-but-reversible operations (host-defined). |
| `elevated` | Stronger proof or role gate (host-defined); typical pairing for high-impact mutating actions. |
| `continuous_resonance_required` | Continued authority or liveness of an approved channel **through execution** (host-defined); not satisfied by one-shot credentials alone. |

**Independence:** orthogonal to execution class (A/B/C). Correlation is allowed (e.g. Class B + `irreversible` often pairs with `elevated` or `continuous_resonance_required`); the worksheet **must** still state both explicitly—no implied pairing in the template.

**Registry:** when `authority_requirements` is stored on `CapabilityDefinition`, validators / membrane **fail closed** if the caller context does not meet the requirement.

---

## 2. Validation rules

Validation runs **only on the host** before a `ZakIdeBridgeRequest` is considered admitted. Order is fixed.

### 2.1 Resolution

1. Resolve `capability` + optional `capability_version` to exactly one `CapabilityDefinition`.
2. If unresolved: reject. No partial match.

### 2.2 JSON Schema (Ajv)

1. Validate `input` against `input_schema` for the resolved version.
2. Failure: reject with schema errors. No repair.

### 2.3 Semantic validator (optional)

1. If registered for this `capability@version`, run semantic validator after Ajv.
2. Failure: reject with semantic error strings. No repair.

### 2.4 Wire object (`prepareExecutionRequest`)

Output must include at minimum:

- `capability` (string)
- `input` (object, unchanged from validated draft)
- `context` (from draft)
- `capability_version` (pinned, exact string from definition)
- `capability_definition_hash` (host-computed from the **same** definition object used to validate; membrane does not recompute)

**Hash semantics:** Compute once at seal time from the resolved definition; do not recompute downstream from partial copies. Purpose: immutable intent, audit, deterministic replay of *which* definition governed the call, and anti-drift between validators and adapters.

### 2.5 Authority requirements

1. After resolution, read `authority_requirements` from the definition (see **Section 1.2**). During migration, if the field is absent in the registry record, treat as `none` only for definitions registered before the field existed; new registrations **must** set it on the worksheet at minimum.
2. Evaluate against caller/session context per host policy. Failure: reject before adapter dispatch. No repair.

---

## 3. Adapter contract

### 3.1 Routing

The host maps `(adapter.key, adapter.route)` to one implementation entrypoint. The registry does not execute adapters.

### 3.2 Input

The adapter receives the validated `input` object. It must not re-validate JSON Schema unless implementing defense in depth; behavior must match registry semantics.

### 3.3 Output

The adapter returns a structured result agreed for this `adapter.route`.  
If no shared schema exists yet, document **Section 5 Output schema** as `application/json` with explicit fields and types.

### 3.4 Errors

Adapters return errors in a host-defined envelope. They do not mutate `capability_version` or definition hash.

### 3.5 Side effects, idempotency, and async

Align with **Section 1.1 Execution class.**

- **Class A:** State read-only; note caching or time-sensitivity if relevant.
- **Class B:** State `side_effect_tier`, idempotency rules, and replay behavior; document ordering or partial-failure handling.
- **Class C:** Document job id, polling vs callback, terminal states, and partial receipts; adapter must not imply synchronous completion unless the response contract is explicitly single-shot.

---

## 4. Membrane and snapshot

1. New `(capability, version)` pairs must be added to the admission whitelist (e.g. `engine/capability_snapshot.json`) when policy allows execution.
2. Dependency map allowlists (e.g. `engine/dependency_map.json`) must include the capability id if ingress paths must admit it.
3. Do not duplicate full schemas inside the snapshot. The snapshot lists pairs only.
4. Where `authority_requirements` is not `none`, membrane or downstream admission **must** consult the resolved definition and reject without adapter dispatch if the caller context is insufficient (fail closed).

---

## 5. Output schema (adapter → host)

Document the **successful** response body shape. Name each field, type, and meaning.

**Example subsection format:**

- **Content-Type:** `application/json`
- **Fields:**
  - `timezone` (string, IANA): Zone used for display.
  - `utc_iso` (string, RFC 3339): Instant in UTC.
  - `local_display` (string): Human-oriented wall time in the zone.

Errors: list error codes or `error` + `detail` pattern if applicable.

---

## 6. Example trace

Use neutral labels. No narrative adjectives.

### 6.1 Inputs

**Draft (UI / model, pre-gate):**

```json
{
  "capability": "<capability id>",
  "input": { }
}
```

**Resolved wire request (post-`prepareExecutionRequest`):**

```json
{
  "capability": "<capability id>",
  "input": { },
  "context": { "constitution_id": "<id>" },
  "capability_version": "<exact version>",
  "capability_definition_hash": "sha256:<64 hex lowercase>"
}
```

### 6.2 Stages

1. `draft` received.  
2. Version resolved.  
3. Ajv validation: pass / fail.  
4. Semantic validation (if any): pass / fail.  
5. Authority requirements (Section 2.5): pass / fail.  
6. Hash computed; request sealed.  
7. Adapter dispatch: `adapter.key` / `adapter.route`.  
8. Adapter response validated against **Section 5** (host policy).  
9. Receipt / log append (host-defined).

### 6.3 Example failure (shape)

Model or client emits non-conforming JSON. Host rejects before adapter. No adapter call.

### 6.4 Example success (abbreviated)

Adapter returns body conforming to **Section 5**. Host records result. End.

---

## 7. Change control

1. **Breaking input change:** bump SemVer; register new version; keep old version until deprecation policy allows removal.  
2. **Adapter route change:** bump SemVer unless route is purely internal and invisible to callers (document exception).  
3. **Hash change:** any material change to `CapabilityDefinition` changes `capability_definition_hash`; update membrane pins and release notes.

### 7.1 Golden test (one per capability)

For each `capability@version`, maintain **one** golden test (or contracted fixture) that asserts:

- Exact canonical input (as validated draft or normalized wire payload—pick one and reuse)
- Exact successful output body (or exact error envelope for the failure golden)
- Exact `capability_definition_hash` for the pinned definition artifact

Store fixtures as static files when practical. Purpose: boring regression detection, not behavioral exploration.

### 7.2 Definition generator (implemented)

**Package:** `@zak/capability-compiler` (`cap-compile` CLI).  
**Input:** structured YAML worksheet (Section 9).  
**Output:** `definition.json`, `definition.hash`, `test.fixture.json`, `test.spec.ts`, `meta.json`, `worksheet.normalized.yaml`.

The compiler normalizes naming, validates class rules **before** any artifact exists, hashes with the same function as the host (`computeCapabilityDefinitionHash`), and generates golden tests. **Do not** hand-author those outputs.

---

## 9. Structured worksheet (YAML) and capability compiler

### 9.1 Controlled input

- **Normative source:** `capabilities/<capability-id>/worksheet.yaml` (or a path passed to the CLI).  
- **Section 10** (markdown) is a sketch checklist only; the YAML worksheet is the machine-parsed contract.

### 9.2 Compiler-only artifacts (invalid if hand-edited)

Under `capabilities/<capability-id>/`, these files **must** be emitted **only** by `cap-compile`. If edited by hand, the capability is invalid until recompiled from `worksheet.yaml`:

| File | Role |
|------|------|
| `definition.json` | Registry `CapabilityDefinition` (hash input) |
| `definition.hash` | One line: `sha256:` + 64 hex (host algorithm) |
| `test.fixture.json` | Golden `input` (required); `output` optional but then exact-assert in `test.spec.ts` |
| `test.spec.ts` | Generated tests: hash, registry validation, optional output equality |
| `worksheet.normalized.yaml` | Deterministic audit copy after normalize |
| `meta.json` | `execution_class`, `authority_requirements`, `output_schema`, class B/C fields — **not** in definition hash |

**Exception:** `worksheet.yaml` is human-maintained.

### 9.3 Hash identity

The digest is **exactly** `computeCapabilityDefinitionHash` from `@zak/capability-registry` over `definition.json` (canonical payload includes `v`, capability, version, adapter, `input_schema`, optional description/tags). Identical worksheets **must** yield identical hashes; if not, the compiler is wrong.

### 9.4 Compiler vs runtime

The compiler **must** be stricter than the live host path: reject bad definitions **before** they exist. The runtime still fail-closes on admission; the compiler fail-closes on **what is allowed to exist**.

### 9.5 Host registry (single runtime truth)

The host **must** register capability **definitions** only from the compiled tree. Do not maintain parallel `CapabilityDefinition` objects in application TypeScript.

- **`createRegistryFromCompiledCapabilities(capabilitiesRoot)`** (`@zak/capability-registry`): load every `definition.json` (flat or `<capability>/<semver>/`), require `definition.hash` and **fail closed** if it does not match `computeCapabilityDefinitionHash`, register definitions and each `meta.json` (governance only), then attach built-in **semantic** validators where needed (not hashed).
- **`prepareExecutionRequest(registry, draft, { authorityContext, governanceRuntime?, classPolicy? })`**: after input validation, enforces `authority_requirements` and execution-class policy from meta vs a provenance-backed host authority resolution (`authorityContext.resolved_authority_level`: `none`, `standard`, `elevated`, `continuous_resonance`; requirements may be `continuous_resonance_required`). Provide `governanceRuntime` for durable replay enforcement. Fail closed if authority context is missing or insufficient.
- **`validateAdapterOutputForCapability`**: after adapter success, validate body against compiled `output_schema` (structured errors only; no silent fixes).
- **`loadDefinitionsFromCapabilitiesDirectory` / `registerCapabilitiesFromDirectory`** / **`createRegistryWithDefaultCapabilitiesRoot`** for custom wiring.
- Optional env: **`ZAK_CAPABILITIES_DIR`** (absolute path) when the tree is not at repo `capabilities/`.

### 9.6 CLI

```bash
cd capability-compiler && npm install && npm run build
node dist/cli.js compile ../capabilities/<capability-id>/worksheet.yaml --out ../capabilities
node dist/cli.js verify ../capabilities
npm test
```

### 9.7 Minimal YAML shape

```yaml
capability: hai.time.get
version: 1.0.0
adapter:
  key: hai-adapter
  route: time.get
execution_class: A
authority_requirements: none
input_schema:
  type: object
  properties: { }
output_schema:
  field_name: string   # shorthand map, or full JSON Schema object with type:
# optional: description, tags
golden:
  input: { }
  # output: { }        # optional; when set, must satisfy output_schema and matches generated EXPECTED_OUTPUT
```

Class **B** / **C** fields match Section 1.1 / Section 10 (required when class is B or C). Unknown top-level keys are rejected.

---

## 10. Blank worksheet (copy below this line)

**Capability id:**  
**Version:**  
**Adapter key:**  
**Adapter route:**  
**Execution class:** A / B / C  
**authority_requirements:** none / standard / elevated / continuous_resonance_required  

**If B — Mutating:**  
**side_effect_tier:** low / medium / irreversible  
**idempotency:** none / keyed (`key field: ___`) / inherent  
**replay_behavior:** blocked / allowed_same_key / allowed_read_only_subset (describe subset if applicable)  

**If C — Long-running:**  
**async_model:** poll / callback / poll_or_callback  
**job_id_field:**  
**partial_receipt:** yes / no (if yes, list states)  

**Read-only (legacy checkbox):** yes / no — must match Class A = yes, B/C = no unless documented exception  

**input_schema summary:**  
(required properties, important constraints)

**Semantic rules:**  
(none / list)

**Output schema summary:**  
(fields)

**Membrane snapshot:** yes / no (if yes, PR reference)  

**Golden test name / path:**  
**Example trace id:** (test name or ticket)

---

*End of template. `template_version` 1.2.0*
