"""Capability snapshot loading and membrane pairing (no schema semantics)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

_ENGINE = Path(__file__).resolve().parent
if str(_ENGINE) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_ENGINE))

from capability_snapshot import (  # noqa: E402
    effective_definition_hash_mode,
    load_capability_snapshot,
    verify_capability_definition_hash_field,
    verify_capability_version_field,
)
from receipts import sha256_hex  # noqa: E402


class CapabilitySnapshotTests(unittest.TestCase):
    def test_load_engine_snapshot(self) -> None:
        path = _ENGINE / "capability_snapshot.json"
        snap = load_capability_snapshot(path)
        self.assertIn(("execute.kernel_bridge", "1.0.0"), snap.allowed_pairs)
        self.assertEqual(snap.content_sha256, sha256_hex(path.read_bytes()))

    def test_expected_sha256_mismatch_raises(self) -> None:
        path = _ENGINE / "capability_snapshot.json"
        with self.assertRaises(ValueError) as ctx:
            load_capability_snapshot(path, expected_sha256="0" * 64)
        self.assertIn("mismatch", str(ctx.exception).lower())

    def test_verify_pair(self) -> None:
        path = _ENGINE / "capability_snapshot.json"
        snap = load_capability_snapshot(path)
        prop_ok = {
            "capability": "memory.write",
            "capability_version": "1.0.0",
            "payload": {},
        }
        v, err = verify_capability_version_field(prop_ok, snap, "memory.write")
        self.assertIsNone(err)
        self.assertEqual(v, "1.0.0")
        v2, err2 = verify_capability_version_field(
            {"capability_version": "99.0.0"}, snap, "execute.kernel_bridge"
        )
        self.assertIsNone(v2)
        self.assertEqual(err2, "capability_version_not_in_snapshot")

    def test_definition_hash_malformed(self) -> None:
        snap = load_capability_snapshot(_ENGINE / "capability_snapshot.json")
        h, err = verify_capability_definition_hash_field(
            {"capability_definition_hash": "not-valid"},
            snap,
            "execute.kernel_bridge",
            "1.0.0",
        )
        self.assertIsNone(h)
        self.assertEqual(err, "capability_definition_hash_malformed")

    def test_definition_hash_pin_match(self) -> None:
        data = json.loads((_ENGINE / "capability_snapshot.json").read_text(encoding="utf-8"))
        want = "sha256:" + "ef" * 32
        data["definition_hash_pins"] = [
            {"capability": "memory.read", "version": "1.0.0", "hash": want}
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp = Path(f.name)
        try:
            snap = load_capability_snapshot(tmp)
            h, err = verify_capability_definition_hash_field(
                {"capability_definition_hash": want},
                snap,
                "memory.read",
                "1.0.0",
            )
            self.assertIsNone(err)
            self.assertEqual(h, want)
        finally:
            tmp.unlink(missing_ok=True)

    def test_effective_definition_hash_mode(self) -> None:
        snap = load_capability_snapshot(_ENGINE / "capability_snapshot.json")
        h = "sha256:" + "ab" * 32
        self.assertEqual(effective_definition_hash_mode(snap, "x", "1", None), "absent")
        self.assertEqual(
            effective_definition_hash_mode(snap, "execute.kernel_bridge", "1.0.0", None),
            "absent",
        )
        self.assertEqual(
            effective_definition_hash_mode(snap, "execute.kernel_bridge", "1.0.0", h),
            "observability",
        )
        data = json.loads((_ENGINE / "capability_snapshot.json").read_text(encoding="utf-8"))
        data["definition_hash_pins"] = [
            {"capability": "execute.kernel_bridge", "version": "1.0.0", "hash": h}
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp = Path(f.name)
        try:
            snap2 = load_capability_snapshot(tmp)
            self.assertEqual(
                effective_definition_hash_mode(snap2, "execute.kernel_bridge", "1.0.0", h),
                "enforced_pinned",
            )
        finally:
            tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
