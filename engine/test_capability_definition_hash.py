"""Optional capability_definition_hash: passthrough, receipt, pin mismatch (membrane never recomputes)."""

from __future__ import annotations

import io
import json
import socket
import tempfile
import unittest
from pathlib import Path

_ENGINE = Path(__file__).resolve().parent
if str(_ENGINE) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_ENGINE))

from adapter_attestation import sha256_file  # noqa: E402
from capability_snapshot import load_capability_snapshot  # noqa: E402
from constitution_resolver import ConstitutionResolver  # noqa: E402
from proxy import KernelCallProxy, load_proxy_policy  # noqa: E402
from receipts import ReceiptSink, set_chain_head  # noqa: E402

_GOOD = "sha256:" + "ab" * 32
_BADFORM = "sha256:zzz"
_PIN = "sha256:" + "aa" * 32
_OTHER = "sha256:" + "cd" * 32


class _FakePopen:
    def poll(self) -> None:
        return None

    def kill(self) -> None:
        pass

    def wait(self, timeout: float | None = None) -> int:
        return 0


def _chat(port: int, frames: list[dict]) -> list[dict]:
    host = "127.0.0.1"
    out: list[dict] = []
    with socket.create_connection((host, port), timeout=10) as s:
        for sf in frames:
            s.sendall((json.dumps(sf) + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(8192)
                if not chunk:
                    break
                buf += chunk
            line, _, rest = buf.partition(b"\n")
            if line:
                out.append(json.loads(line.decode("utf-8")))
            if rest:
                raise RuntimeError("unexpected extra data in response")
    return out


class CapabilityDefinitionHashMembraneTests(unittest.TestCase):
    def setUp(self) -> None:
        set_chain_head("")
        self._sink = io.StringIO()
        bundle = _ENGINE.parent / "zak-adapters" / "dist" / "index.js"
        if not bundle.is_file():
            self.skipTest("zak-adapters/dist/index.js missing; run npm build")
        self._bundle_hash = sha256_file(bundle)
        with (_ENGINE / "dependency_map.json").open(encoding="utf-8") as fob:
            self._map = json.load(fob)
        self._policy = load_proxy_policy(self._map)
        self._resolver = ConstitutionResolver(_ENGINE / "constitutions.json")
        gold = _ENGINE.parent / "zak-core"

        def _make_proxy(snap_path: Path) -> KernelCallProxy:
            snap = load_capability_snapshot(snap_path)
            p = KernelCallProxy(
                self._policy,
                resolver=self._resolver,
                gold_root=gold,
                dependency_map_path=_ENGINE / "dependency_map.json",
                expected_bundle_hashes={"http": self._bundle_hash},
                adapter_id_oracles={"http": "pilot-http"},
                capability_snapshot=snap,
                receipt_sink=ReceiptSink(self._sink),
                log=lambda *_a: None,
            )
            p.start_listener("127.0.0.1", 0)
            assert p._server is not None
            p.register_client("cid-hash", _FakePopen(), "http", "pilot-http")
            return p

        self._make_proxy = _make_proxy
        self._gold = gold
        self._proxy = _make_proxy(_ENGINE / "capability_snapshot.json")
        self._port = self._proxy._server.server_address[1]

    def tearDown(self) -> None:
        self._proxy.stop()

    def _receipts(self) -> list[dict]:
        lines = [ln for ln in self._sink.getvalue().splitlines() if ln.strip()]
        return [json.loads(ln) for ln in lines]

    def test_malformed_capability_definition_hash_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-hash",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "capability_definition_hash": _BADFORM,
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "dh-bad",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("error"), "malformed_capability_definition_hash")

    def test_pinned_mismatch_rejected(self) -> None:
        data = json.loads((_ENGINE / "capability_snapshot.json").read_text(encoding="utf-8"))
        data["definition_hash_pins"] = [
            {
                "capability": "execute.kernel_bridge",
                "version": "1.0.0",
                "hash": _PIN,
            }
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp = Path(f.name)
        try:
            self._proxy.stop()
            self._sink.seek(0)
            self._sink.truncate(0)
            self._proxy = self._make_proxy(tmp)
            self._port = self._proxy._server.server_address[1]
            frames = [
                {
                    "op": "register",
                    "client_id": "cid-hash",
                    "plugin": "http",
                    "adapter_id": "pilot-http",
                    "declared_capabilities": ["execute.kernel_bridge"],
                    "adapter_bundle_hash": self._bundle_hash,
                },
                {
                    "op": "admit",
                    "constitution_id": "zak-default",
                    "proposal": {
                        "capability": "execute.kernel_bridge",
                        "capability_version": "1.0.0",
                        "capability_definition_hash": _OTHER,
                        "from_module": "adapters/http/adapter",
                        "to_module": "kernel/runner",
                        "intent_id": "dh-mm",
                        "payload": {},
                    },
                },
            ]
            replies = _chat(self._port, frames)
            self.assertEqual(replies[1].get("error"), "capability_definition_hash_mismatch")
        finally:
            tmp.unlink(missing_ok=True)

    def test_well_formed_hash_recorded_on_receipt(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-hash",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "capability_definition_hash": _GOOD,
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "dh-ok",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertTrue(replies[1].get("ok"))
        rid = replies[1]["admit_receipt_id"]
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("capability_definition_hash"), _GOOD)
        self.assertEqual(rec.get("capability_definition_hash_mode"), "observability")

    def test_pinned_hash_receipt_mode_enforced(self) -> None:
        data = json.loads((_ENGINE / "capability_snapshot.json").read_text(encoding="utf-8"))
        data["definition_hash_pins"] = [
            {
                "capability": "execute.kernel_bridge",
                "version": "1.0.0",
                "hash": _GOOD,
            }
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp = Path(f.name)
        try:
            self._proxy.stop()
            self._sink.seek(0)
            self._sink.truncate(0)
            self._proxy = self._make_proxy(tmp)
            self._port = self._proxy._server.server_address[1]
            frames = [
                {
                    "op": "register",
                    "client_id": "cid-hash",
                    "plugin": "http",
                    "adapter_id": "pilot-http",
                    "declared_capabilities": ["execute.kernel_bridge"],
                    "adapter_bundle_hash": self._bundle_hash,
                },
                {
                    "op": "admit",
                    "constitution_id": "zak-default",
                    "proposal": {
                        "capability": "execute.kernel_bridge",
                        "capability_version": "1.0.0",
                        "capability_definition_hash": _GOOD,
                        "from_module": "adapters/http/adapter",
                        "to_module": "kernel/runner",
                        "intent_id": "dh-pin-ok",
                        "payload": {},
                    },
                },
            ]
            replies = _chat(self._port, frames)
            self.assertTrue(replies[1].get("ok"))
            rid = replies[1]["admit_receipt_id"]
            rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
            self.assertEqual(rec.get("capability_definition_hash_mode"), "enforced_pinned")
        finally:
            tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
