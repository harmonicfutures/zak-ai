"""ZAK-Adapters npm package — build boundary before starting I/O plugins."""

from __future__ import annotations

import subprocess
from pathlib import Path


class AdaptersRuntime:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()

    def _npm(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["npm", *args],
            cwd=self.path,
            check=check,
            text=True,
            capture_output=True,
        )

    def ensure_dependencies(self) -> None:
        if not (self.path / "node_modules").is_dir():
            self._npm("install")

    def build(self) -> None:
        self._npm("run", "build")
