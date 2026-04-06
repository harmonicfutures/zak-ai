"""Constitution id → policy_hash resolution. Read-only; no zak-core mutation."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from receipts import canonical_json_bytes, sha256_hex


@dataclass(frozen=True)
class ResolvedConstitution:
    constitution_id: str
    policy_hash: str
    overlay_ids: tuple[str, ...]


class ConstitutionResolver:
    """
    Cached read-only resolver. policy_hash = sha256(canonical(base record + overlays)).
    Unknown id → resolution fails (proxy must kill / reject).

    Cache invalidation uses the full registry file content hash (not mtime) so reloads are
    deterministic under concurrent readers and clock quirks.
    """

    def __init__(self, registry_path: Path | None = None) -> None:
        raw_env = os.environ.get("ZAKAI_CONSTITUTION_REGISTRY")
        path = registry_path or (Path(raw_env) if raw_env else Path(__file__).resolve().parent / "constitutions.json")
        self._path = path
        self._content_sha256: str | None = None
        self._cache: dict[str, ResolvedConstitution] = {}
        self._lock = threading.Lock()

    def _rebuild_from_bytes(self, raw_bytes: bytes) -> None:
        data = json.loads(raw_bytes.decode("utf-8"))
        consts = data.get("constitutions")
        if not isinstance(consts, dict):
            raise ValueError("constitutions.json: missing constitutions object")
        new_cache: dict[str, ResolvedConstitution] = {}
        for cid, entry in consts.items():
            if not isinstance(entry, dict):
                continue
            overlays = entry.get("overlays") or []
            if not isinstance(overlays, list):
                overlays = []
            overlay_ids = tuple(str(o.get("id", f"idx{i}")) for i, o in enumerate(overlays) if isinstance(o, dict))
            base = {"constitution_id": cid, "entry": entry, "overlays": overlays}
            policy_hash = sha256_hex(canonical_json_bytes(base))
            new_cache[cid] = ResolvedConstitution(
                constitution_id=cid,
                policy_hash=f"sha256:{policy_hash}",
                overlay_ids=overlay_ids,
            )
        self._cache = new_cache

    def _refresh_if_needed_unlocked(self) -> None:
        if not self._path.is_file():
            raise FileNotFoundError(f"constitution registry missing: {self._path}")
        raw_bytes = self._path.read_bytes()
        h = sha256_hex(raw_bytes)
        if h == self._content_sha256:
            return
        self._content_sha256 = h
        self._rebuild_from_bytes(raw_bytes)

    def resolve(self, constitution_id: str) -> ResolvedConstitution:
        with self._lock:
            self._refresh_if_needed_unlocked()
            if constitution_id not in self._cache:
                raise KeyError(f"unknown constitution_id: {constitution_id!r}")
            return self._cache[constitution_id]
