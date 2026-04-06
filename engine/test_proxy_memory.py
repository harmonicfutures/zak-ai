"""Memory capabilities (memory.read / memory.write): scope, admission, receipts, no proxy-side retention."""

from __future__ import annotations

import io
import json
import socket
import unittest
from dataclasses import fields
from pathlib import Path

_ENGINE = Path(__file__).resolve().parent
if str(_ENGINE) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_ENGINE))

from adapter_attestation import sha256_file  # noqa: E402
from capability_snapshot import load_capability_snapshot  # noqa: E402
from constitution_resolver import ConstitutionResolver  # noqa: E402
from proxy import KernelCallProxy, _AdmitTicket, load_proxy_policy  # noqa: E402
from receipts import ReceiptSink, set_chain_head  # noqa: E402


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


class ProxyMemoryCapabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        set_chain_head("")
        self._sink = io.StringIO()
        self._gov: list[str] = []

        def _gov_log(msg: str) -> None:
            self._gov.append(msg)

        bundle = _ENGINE.parent / "zak-adapters" / "dist" / "index.js"
        if not bundle.is_file():
            self.skipTest("zak-adapters/dist/index.js missing; run npm build")
        self._bundle_hash = sha256_file(bundle)
        with (_ENGINE / "dependency_map.json").open(encoding="utf-8") as fob:
            self._map = json.load(fob)
        self._policy = load_proxy_policy(self._map)
        self._resolver = ConstitutionResolver(_ENGINE / "constitutions.json")
        gold = _ENGINE.parent / "zak-core"
        self._cap_snapshot = load_capability_snapshot(_ENGINE / "capability_snapshot.json")
        self._proxy = KernelCallProxy(
            self._policy,
            resolver=self._resolver,
            gold_root=gold,
            dependency_map_path=_ENGINE / "dependency_map.json",
            expected_bundle_hashes={"http": self._bundle_hash},
            adapter_id_oracles={"http": "pilot-http"},
            capability_snapshot=self._cap_snapshot,
            receipt_sink=ReceiptSink(self._sink),
            log=lambda *a: _gov_log(str(a[0])) if a else None,
        )
        self._proxy.start_listener("127.0.0.1", 0)
        assert self._proxy._server is not None
        self._port = self._proxy._server.server_address[1]
        self._proxy.register_client("cid-mem", _FakePopen(), "http", "pilot-http")

    def tearDown(self) -> None:
        self._proxy.stop()

    def _receipts(self) -> list[dict]:
        lines = [ln for ln in self._sink.getvalue().splitlines() if ln.strip()]
        return [json.loads(ln) for ln in lines]

    def test_memory_write_without_capability_scope_rejected(self) -> None:
        """Session allows only execute.kernel_bridge; memory.write must not pass admit."""
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "memory.write",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "mem-deny",
                    "payload": {"memory_scope": "user:1", "body": "x"},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "capability_denied")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("capability"), "memory.write")
        self.assertEqual(rec.get("decision_reason"), "capability_violation")
        self.assertEqual(rec.get("memory_operation"), "write")
        self.assertEqual(rec.get("memory_scope"), "user:1")

    def test_memory_read_execute_without_admission_rejected(self) -> None:
        proposal = {
            "capability": "memory.read",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "mem-no-admit",
            "payload": {"memory_scope": "user:1"},
        }
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["memory.read", "execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "execute",
                "admit_ticket": "not-a-real-ticket",
                "admit_receipt_id": "not-a-real-receipt",
                "proposal": proposal,
                "envelope": {"intentId": proposal["intent_id"], "payload": proposal["payload"]},
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "execute_not_admitted")

    def test_valid_memory_write_admitted_and_receipt_includes_scope(self) -> None:
        proposal = {
            "capability": "memory.write",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "mem-ok",
            "payload": {"memory_scope": "session:abc", "blob": {"k": 1}},
        }
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge", "memory.write"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": proposal,
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), True)
        self.assertEqual(replies[1].get("admitted"), True)
        admit_rid = replies[1]["admit_receipt_id"]
        rec = next(r for r in self._receipts() if r.get("receipt_id") == admit_rid)
        self.assertEqual(rec.get("capability"), "memory.write")
        self.assertEqual(rec.get("decision"), "admitted")
        self.assertEqual(rec.get("memory_operation"), "write")
        self.assertEqual(rec.get("memory_scope"), "session:abc")
        self.assertEqual(rec.get("capability_version"), "1.0.0")

    def test_memory_scope_trimmed_on_receipt(self) -> None:
        proposal = {
            "capability": "memory.write",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "mem-trim",
            "payload": {"memory_scope": "  padded:id  ", "blob": 1},
        }
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge", "memory.write"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {"op": "admit", "constitution_id": "zak-default", "proposal": proposal},
        ]
        replies = _chat(self._port, frames)
        self.assertTrue(replies[1].get("ok"))
        admit_rid = replies[1]["admit_receipt_id"]
        rec = next(r for r in self._receipts() if r.get("receipt_id") == admit_rid)
        self.assertEqual(rec.get("memory_scope"), "padded:id")

    def test_memory_scope_oversized_rejected(self) -> None:
        long_scope = "a" * (256 + 1)
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge", "memory.write"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "memory.write",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "mem-long",
                    "payload": {"memory_scope": long_scope, "x": 1},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "memory_scope_too_long")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("decision_reason"), "policy_violation")
        self.assertEqual(rec.get("memory_operation"), "write")
        self.assertNotIn("memory_scope", rec)

    def test_memory_scope_whitespace_only_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-mem",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["memory.read", "execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "memory.read",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "mem-ws",
                    "payload": {"memory_scope": "  \t  "},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "memory_scope_invalid")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("memory_operation"), "read")
        self.assertEqual(rec.get("decision_reason"), "policy_violation")

    def test_valid_memory_write_execute_receipt_and_no_ticket_retention(self) -> None:
        proposal = {
            "capability": "memory.write",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "mem-exec",
            "payload": {"memory_scope": "session:xyz", "blob": [1, 2]},
        }
        register_f = {
            "op": "register",
            "client_id": "cid-mem",
            "plugin": "http",
            "adapter_id": "pilot-http",
            "declared_capabilities": ["execute.kernel_bridge", "memory.write"],
            "adapter_bundle_hash": self._bundle_hash,
        }
        admit_f = {
            "op": "admit",
            "constitution_id": "zak-default",
            "proposal": proposal,
        }

        def _sr(sock: socket.socket, obj: dict) -> dict:
            sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf:
                buf += sock.recv(8192)
            line, _, _ = buf.partition(b"\n")
            return json.loads(line.decode("utf-8"))

        with socket.create_connection(("127.0.0.1", self._port), timeout=10) as s:
            self.assertTrue(_sr(s, register_f).get("ok"))
            r_ad = _sr(s, admit_f)
            self.assertTrue(r_ad.get("ok"))
            ticket = r_ad["admit_ticket"]
            r_ex = _sr(
                s,
                {
                    "op": "execute",
                    "admit_ticket": ticket,
                    "admit_receipt_id": r_ad["admit_receipt_id"],
                    "proposal": proposal,
                    "envelope": {"intentId": proposal["intent_id"], "payload": proposal["payload"]},
                },
            )
        self.assertTrue(r_ex.get("ok"))
        exec_rid = r_ex.get("execute_receipt_id")
        self.assertIsInstance(exec_rid, str)
        ex_rec = next(r for r in self._receipts() if r.get("receipt_id") == exec_rid)
        self.assertEqual(ex_rec.get("capability"), "memory.write")
        self.assertEqual(ex_rec.get("memory_operation"), "write")
        self.assertEqual(ex_rec.get("memory_scope"), "session:xyz")
        self.assertEqual(ex_rec.get("capability_version"), "1.0.0")
        self.assertEqual(ex_rec.get("decision"), "executed")

        self.assertEqual(self._proxy._admit_tickets, {})
        names = {f.name for f in fields(_AdmitTicket)}
        self.assertNotIn("payload", names)
        self.assertNotIn("memory_scope", names)
        mem_attrs = [k for k in self._proxy.__dict__.keys() if "memory" in k.lower()]
        self.assertEqual(mem_attrs, [], msg="proxy must not add memory storage attributes")


if __name__ == "__main__":
    unittest.main()
