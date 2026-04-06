"""Adapter I/O plugins — each owns a Node (or future) child process."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class AdapterContext:
    adapters_root: Path
    gold_root: Path
    extra_env: dict[str, str] = field(default_factory=dict)


class AdapterPlugin(Protocol):
    name: str

    def start(self, ctx: AdapterContext) -> subprocess.Popen[str] | None: ...

    def describe(self) -> str: ...


def _popen_npm_start(
    cwd: Path,
    env: dict[str, str],
    *,
    adapter_type: str,
    port: str | None,
) -> subprocess.Popen[str]:
    merged = {**os.environ, **env, "ADAPTER_TYPE": adapter_type}
    if port is not None:
        merged["PORT"] = port
    return subprocess.Popen(
        ["npm", "start"],
        cwd=cwd,
        env=merged,
        text=True,
    )


@dataclass
class NpmAdapterPlugin:
    """Shared npm ``start`` helper for zak-adapters package."""

    name: str
    adapter_type: str
    port: str | None = "8080"

    def _base_env(self, ctx: AdapterContext) -> dict[str, str]:
        return {
            "ZAKAI_GOLD": str(ctx.gold_root),
            "ZAKAI_ADAPTERS": str(ctx.adapters_root),
            **ctx.extra_env,
        }

    def start(self, ctx: AdapterContext) -> subprocess.Popen[str]:
        return _popen_npm_start(
            ctx.adapters_root,
            self._base_env(ctx),
            adapter_type=self.adapter_type,
            port=self.port,
        )

    def describe(self) -> str:
        p = f" port={self.port}" if self.port else ""
        return f"{self.name} (ADAPTER_TYPE={self.adapter_type}{p})"

    def http_health_url(self) -> str | None:
        """L7 health probe for HTTP adapters; other plugins use process liveness only."""
        if self.adapter_type == "http" and self.port:
            return f"http://127.0.0.1:{self.port}/zak/health"
        return None
