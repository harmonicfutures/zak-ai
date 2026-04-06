"""
Admission whitelist for the membrane: which (capability, version) pairs may be admitted.

This is not a second registry. It does not carry JSON Schema, semantic validators, or adapter
binding — those stay in the host ``capability-registry`` (or adjacent artifacts). If this file
and the registry drift because release tooling skipped regeneration, admission fails closed: that
is intentional.

Operational coupling: refresh this snapshot in lockstep with registry/core capability rollouts.
Pin the file bytes with ``ZAK_CAPABILITY_SNAPSHOT_SHA256`` so the allowlist cannot change
silently under the same deploy label.

Provenance (future, not implemented here): the host may attach a
``capability_definition_hash`` derived at prepare time from the definition actually used.
The membrane should **verify** that value against a pinned expectation (or pass through to
receipts only), not **recompute** it from a parallel definition store — recomputation reintroduces
dual truth.

Release ergonomics: prefer one pipeline motion (registry artifact + whitelist JSON + expected
sha256 + bundle) so integrity steps are not optional tribal knowledge.

Rollout modes (operational — today’s code supports all three; don’t assume stronger guarantees
than configured):

- **Observability:** host may send ``capability_definition_hash``; membrane records it on receipts;
  no pin required; missing hash is allowed.
- **Enforcement:** require hash on wire + populate ``definition_hash_pins`` for the pairs you
  care about (policy “require hash” is not a separate code path yet — combine mandatory host
  behavior with pins for fail-closed mismatch).
- **Mixed:** pins only for specific (capability, version) rows; others stay record-only.

**Do not** add hash recomputation in the proxy “for safety” — that revives two truths
(host digest vs membrane digest) and turns mismatches into noise.

Invariant (loader boundary — read this before extending the JSON shape):

- ``capability_snapshot`` is an admission whitelist artifact. It defines which
  (capability, version) pairs may be admitted, and optional pinned hashes for those pairs.
  It does NOT define schemas, semantics, or adapter behavior.
- All operational meaning lives in the host registry/bundle. If additional fields here begin to
  influence execution semantics, a second registry has been created and the separation of concerns
  is broken.
- The snapshot MUST be treated as a release artifact: integrity is enforced via the expected
  SHA256. Drift between registry and snapshot is a fail-closed condition by design.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from receipts import sha256_hex

CAPABILITY_VERSION_MAX_LEN = 256

_CAPABILITY_DEFINITION_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class CapabilitySnapshot:
    """Pinned allowlist loaded from JSON; drift-resistant when combined with content hash check."""

    allowed_pairs: frozenset[tuple[str, str]]
    content_sha256: str
    """Release-pinned expected hashes from the same artifact as this file; membrane compares, never recomputes."""
    definition_hash_pins: Mapping[tuple[str, str], str]


def load_capability_snapshot(
    path: Path,
    *,
    expected_sha256: str | None = None,
) -> CapabilitySnapshot:
    """
    Load snapshot from disk. If ``expected_sha256`` is set (e.g. ZAK_CAPABILITY_SNAPSHOT_SHA256),
    file bytes must match (hex, with or without sha256: prefix). Fail closed on mismatch.
    """
    if not path.is_file():
        raise FileNotFoundError(f"capability snapshot missing: {path}")
    raw = path.read_bytes()
    digest = sha256_hex(raw)
    if expected_sha256 is not None:
        exp = expected_sha256.strip().lower()
        if exp.startswith("sha256:"):
            exp = exp[7:]
        if exp != digest:
            raise ValueError(
                f"capability snapshot sha256 mismatch for {path}: "
                f"expected {exp} got {digest}"
            )
    data: dict[str, Any] = json.loads(raw.decode("utf-8"))
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise ValueError("capability_snapshot.json: entries must be a list")
    pairs: set[tuple[str, str]] = set()
    for i, item in enumerate(entries):
        if not isinstance(item, dict):
            raise ValueError(f"capability_snapshot.json: entries[{i}] must be an object")
        c = item.get("capability")
        v = item.get("version")
        if not isinstance(c, str) or not isinstance(v, str):
            raise ValueError(f"capability_snapshot.json: entries[{i}] need string capability and version")
        ct = c.strip()
        vt = v.strip()
        if not ct or not vt:
            raise ValueError(f"capability_snapshot.json: entries[{i}] empty capability or version")
        pairs.add((ct, vt))
    pin_raw = data.get("definition_hash_pins")
    pins: dict[tuple[str, str], str] = {}
    if pin_raw is not None:
        if not isinstance(pin_raw, list):
            raise ValueError("capability_snapshot.json: definition_hash_pins must be a list")
        for j, pin in enumerate(pin_raw):
            if not isinstance(pin, dict):
                raise ValueError(f"capability_snapshot.json: definition_hash_pins[{j}] must be an object")
            pc = pin.get("capability")
            pv = pin.get("version")
            ph = pin.get("hash")
            if not isinstance(pc, str) or not isinstance(pv, str) or not isinstance(ph, str):
                raise ValueError(
                    f"capability_snapshot.json: definition_hash_pins[{j}] need capability, version, hash strings"
                )
            pct, pvt, pht = pc.strip(), pv.strip(), ph
            if not pct or not pvt:
                raise ValueError(f"capability_snapshot.json: definition_hash_pins[{j}] empty capability or version")
            if not _CAPABILITY_DEFINITION_HASH_RE.fullmatch(pht):
                raise ValueError(
                    f"capability_snapshot.json: definition_hash_pins[{j}] hash must be sha256:<64 hex lowercase>"
                )
            pins[(pct, pvt)] = pht
    return CapabilitySnapshot(
        allowed_pairs=frozenset(pairs),
        content_sha256=digest,
        definition_hash_pins=pins,
    )


def effective_definition_hash_mode(
    snapshot: CapabilitySnapshot,
    capability: str,
    capability_version: str | None,
    capability_definition_hash: str | None,
) -> str:
    """
    Introspection for receipts and gov logs (not policy).

    - No hash on wire → ``absent``.
    - Hash present and this (capability, version) is in ``definition_hash_pins`` → definition
      hash was compared to a release pin → ``enforced_pinned``.
    - Hash present, no pin for this pair → record-only → ``observability``.
    """
    if not capability_definition_hash:
        return "absent"
    c = capability.strip()
    cv = (capability_version or "").strip()
    if (c, cv) in snapshot.definition_hash_pins:
        return "enforced_pinned"
    return "observability"


def verify_capability_version_field(
    proposal: Mapping[str, Any],
    snapshot: CapabilitySnapshot,
    capability: str,
) -> tuple[str | None, str | None]:
    """
    Membrane check: explicit non-empty capability_version required; pair must appear in snapshot.
    Returns (normalized_version, None) or (None, error_code). No implicit latest.
    """
    raw = proposal.get("capability_version")
    if raw is None:
        return None, "capability_version_missing"
    if not isinstance(raw, str):
        return None, "capability_version_invalid"
    s = raw.strip()
    if not s:
        return None, "capability_version_missing"
    if len(s) > CAPABILITY_VERSION_MAX_LEN:
        return None, "capability_version_invalid"
    if (capability, s) not in snapshot.allowed_pairs:
        return None, "capability_version_not_in_snapshot"
    return s, None


def verify_capability_definition_hash_field(
    proposal: Mapping[str, Any],
    snapshot: CapabilitySnapshot,
    capability: str,
    capability_version: str,
) -> tuple[str | None, str | None]:
    """
    Optional host-asserted definition identity. Omitted → allowed. Present → must match
    ``sha256:[0-9a-f]{64}`` exactly (no strip/normalize). Compared to snapshot pin if one exists.

    **Never recompute** ``capability_definition_hash`` here or in the proxy from a local copy of
    definitions — compare or record the asserted string only.
    """
    raw = proposal.get("capability_definition_hash")
    if raw is None:
        return None, None
    if not isinstance(raw, str):
        return None, "capability_definition_hash_invalid"
    if not _CAPABILITY_DEFINITION_HASH_RE.fullmatch(raw):
        return None, "capability_definition_hash_malformed"
    pin = snapshot.definition_hash_pins.get((capability, capability_version))
    if pin is not None and pin != raw:
        return None, "capability_definition_hash_mismatch"
    return raw, None
