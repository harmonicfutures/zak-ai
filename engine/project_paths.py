"""Resolve ZAK-Gold (kernel) and ZAK-Adapters roots with env overrides."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ZakaiRoots:
    workspace: Path
    gold: Path
    adapters: Path


def _first_existing(base: Path, names: tuple[str, ...]) -> Path | None:
    for name in names:
        p = base / name
        if p.is_dir():
            return p.resolve()
    return None


def resolve_roots(workspace: Path | None = None) -> ZakaiRoots:
    """
    Default workspace is the parent of ``engine/`` (ZAKAI repo root).

    Override with ``ZAKAI_GOLD`` and ``ZAKAI_ADAPTERS`` (absolute or relative paths).
    """
    engine_dir = Path(__file__).resolve().parent
    ws = (workspace or engine_dir.parent).resolve()

    gold_env = os.environ.get("ZAKAI_GOLD")
    adapters_env = os.environ.get("ZAKAI_ADAPTERS")

    def _env_path(raw: str) -> Path:
        p = Path(raw)
        return p.resolve() if p.is_absolute() else (ws / p).resolve()

    gold = _env_path(gold_env) if gold_env else _first_existing(ws, ("ZAK-Gold", "zak-core"))
    adapters = _env_path(adapters_env) if adapters_env else _first_existing(ws, ("ZAK-Adapters", "zak-adapters"))

    if gold is None:
        raise FileNotFoundError(
            "Missing gold tree: expected ZAK-Gold or zak-core under " + str(ws)
            + " (or set ZAKAI_GOLD)"
        )
    if adapters is None:
        raise FileNotFoundError(
            "Missing adapters tree: expected ZAK-Adapters or zak-adapters under " + str(ws)
            + " (or set ZAKAI_ADAPTERS)"
        )
    return ZakaiRoots(workspace=ws, gold=gold, adapters=adapters)
