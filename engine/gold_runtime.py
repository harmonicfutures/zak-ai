"""ZAK-Gold (sovereign kernel) — subprocess boundary; never imported as Python."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


class GoldRuntime:
    """Immutable execution environment at ``path`` (npm package)."""

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

    def verify(self) -> None:
        ok, detail = self.verify_report()
        if not ok:
            sys.stderr.write(detail)
            raise RuntimeError(f"Gold verification failed in {self.path}")

    def verify_report(self) -> tuple[bool, str]:
        """Run ``npm run verify``; return success and combined output (for supervision / logging)."""
        proc = self._npm("run", "verify", check=False)
        detail = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            return False, detail
        return True, detail
