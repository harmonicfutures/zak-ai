"""Optional live import scan of TypeScript sources (relative edges under src/)."""

from __future__ import annotations

import json
import re
from pathlib import Path

_TS_IMPORT = re.compile(r"""from\s+['"](\.\.?/[^'"]+)['"]""")

_EXTS = (".ts", ".tsx")


def scan_local_imports(src_root: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not src_root.is_dir():
        return out
    for path in src_root.rglob("*"):
        if path.suffix not in _EXTS:
            continue
        rel = path.relative_to(src_root).as_posix()
        imports: list[str] = []
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in _TS_IMPORT.finditer(text):
            imports.append(m.group(1))
        if imports:
            out[rel] = sorted(set(imports))
    return out


def print_index(src_root: Path, label: str) -> None:
    data = scan_local_imports(src_root)
    print(f"--- {label} ({src_root}) — {len(data)} files with local imports ---")
    print(json.dumps(data, indent=2))
