"""Subprocess bridge to Gold gate (engine/gold_invoke.mjs). No interpretation."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


def invoke_gold(gold_root: Path, envelope: dict[str, Any], correlation_id: str) -> dict[str, Any]:
    script = Path(__file__).resolve().parent / "gold_invoke.mjs"
    payload = json.dumps(
        {"envelope": envelope, "correlationId": correlation_id},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    env = {**os.environ, "ZAKAI_GOLD": str(gold_root.resolve())}
    proc = subprocess.run(
        ["node", str(script)],
        input=payload,
        text=True,
        capture_output=True,
        timeout=120,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return {
            "ok": False,
            "outcome": "denied",
            "error": proc.stderr.strip() or f"gold_invoke exit {proc.returncode}",
        }
    line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"ok": False, "outcome": "denied", "error": "gold_invoke invalid stdout"}
