"""Proxy authority boundaries: capability rejection receipts, policy hash authority."""

from __future__ import annotations

import io
import json
import socket
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


class ProxyBoundaryTests(unittest.TestCase):
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
        self._proxy.register_client("cid-cap", _FakePopen(), "http", "pilot-http")

    def tearDown(self) -> None:
        self._proxy.stop()

    def _receipts(self) -> list[dict]:
        lines = [ln for ln in self._sink.getvalue().splitlines() if ln.strip()]
        return [json.loads(ln) for ln in lines]

    def test_capability_outside_scope_rejects_with_receipt(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "proposal": {
                    "capability": "execute.evil_not_allowed",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "intent-1",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "capability_denied")
        self.assertIn("receipt_id", replies[1])
        rids = {r["receipt_id"] for r in self._receipts()}
        self.assertIn(replies[1]["receipt_id"], rids)
        rej = next(
            r
            for r in self._receipts()
            if r.get("receipt_id") == replies[1]["receipt_id"]
        )
        self.assertEqual(rej.get("decision"), "rejected")
        self.assertEqual(rej.get("decision_reason"), "capability_violation")
        self.assertIs(rej.get("trusted"), True)
        self.assertIs(rej.get("capability_valid"), False)
        self.assertEqual(rej.get("capability"), "execute.evil_not_allowed")
        self.assertEqual(rej.get("capability_version"), "1.0.0")

    def test_forged_policy_hash_claim_ignored_admit_ok(self) -> None:
        resolved = self._resolver.resolve("zak-default")
        forged = "sha256:" + "0" * 64
        self.assertNotEqual(forged, resolved.policy_hash)
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "policy_hash_claim": forged,
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "intent-2",
                    "payload": {"q": 1},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), True)
        self.assertEqual(replies[1].get("admitted"), True)
        self.assertEqual(replies[1].get("policy_hash"), resolved.policy_hash)
        admit_rid = replies[1].get("admit_receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == admit_rid)
        self.assertEqual(rec.get("policy_hash"), resolved.policy_hash)
        self.assertIsNone(rec.get("decision_reason"))
        claim_logs = [json.loads(x) for x in self._gov if x.startswith("{")]
        adv = [x for x in claim_logs if x.get("gov") == "adapter_policy_hash_claim"]
        self.assertEqual(len(adv), 1)
        self.assertEqual(adv[0].get("claim"), forged)
        self.assertEqual(adv[0].get("policy_hash"), resolved.policy_hash)
        self.assertEqual(adv[0].get("client_id"), "cid-cap")
        self.assertEqual(adv[0].get("constitution_id"), "zak-default")
        self.assertEqual(adv[0].get("adapter_id"), "pilot-http")
        self.assertEqual(rec.get("capability_version"), "1.0.0")

    def test_missing_constitution_id_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "i-miss-c",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "missing_constitution_id")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("decision"), "rejected")
        self.assertEqual(rec.get("decision_reason"), "policy_violation")
        self.assertIs(rec.get("context_present"), False)
        logs = [json.loads(x) for x in self._gov if x.startswith("{")]
        ar = [x for x in logs if x.get("gov") == "admit_rejected"]
        self.assertTrue(ar)
        self.assertEqual(ar[0].get("detail"), "missing_constitution_id")
        self.assertIsNone(ar[0].get("constitution_id"))

    def test_invalid_constitution_id_fail_closed_kill(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "not-a-real-constitution-id-xyz",
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "i-bad",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "constitution_invalid")
        killed = [r for r in self._receipts() if r.get("decision") == "killed"]
        self.assertTrue(killed)
        self.assertEqual(killed[-1].get("decision_reason"), "policy_violation")

    def test_valid_context_envelope_passthrough_ok(self) -> None:
        resolved = self._resolver.resolve("zak-default")
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "context": {
                    "constitution_id": "zak-default",
                    "tags": ["pilot", "http"],
                    "metadata": {"unit": "test"},
                    "correlation_id": "trace-1",
                },
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "i-ctx",
                    "payload": {"n": 1},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[0].get("ok"), True)
        self.assertEqual(replies[1].get("ok"), True)
        admit_rid = replies[1].get("admit_receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == admit_rid)
        self.assertEqual(rec.get("constitution_id"), resolved.constitution_id)
        self.assertIs(rec.get("context_present"), True)
        self.assertEqual(rec.get("policy_hash"), resolved.policy_hash)
        logs = [json.loads(x) for x in self._gov if x.startswith("{")]
        ok = [x for x in logs if x.get("gov") == "admit_ok"]
        self.assertEqual(len(ok), 1)
        self.assertEqual(ok[0].get("constitution_id"), resolved.constitution_id)
        self.assertEqual(ok[0].get("policy_hash"), resolved.policy_hash)

    def test_constitution_id_context_top_level_mismatch_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
            {
                "op": "admit",
                "constitution_id": "zak-default",
                "context": {"constitution_id": "other-claimed-id"},
                "proposal": {
                    "capability": "execute.kernel_bridge",
                    "capability_version": "1.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "i-mm",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "constitution_id_mismatch")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("decision_reason"), "policy_violation")

    def test_unknown_client_id_emits_untrusted_receipt(self) -> None:
        set_chain_head("")
        self._sink.seek(0)
        self._sink.truncate(0)
        self._gov.clear()
        port = self._port
        frames = [
            {
                "op": "register",
                "client_id": "not-registered-slot",
                "plugin": "http",
                "adapter_id": "pilot-http",
                "declared_capabilities": ["execute.kernel_bridge"],
                "adapter_bundle_hash": self._bundle_hash,
            },
        ]
        replies = _chat(port, frames)
        self.assertEqual(replies[0].get("ok"), False)
        self.assertEqual(replies[0].get("error"), "unknown client_id")
        rid = replies[0].get("receipt_id")
        self.assertIsInstance(rid, str)
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("decision"), "rejected")
        self.assertEqual(rec.get("decision_reason"), "unknown_client")
        self.assertIs(rec.get("trusted"), False)
        self.assertIsNone(rec.get("adapter_id"))
        self.assertEqual(rec.get("client_id"), "not-registered-slot")
        logs = [json.loads(x) for x in self._gov if x.startswith("{")]
        ut = [x for x in logs if x.get("gov") == "untrusted_registration"]
        self.assertEqual(len(ut), 1)
        self.assertIsNone(ut[0].get("adapter_id"))
        self.assertEqual(ut[0].get("client_id"), "not-registered-slot")
        self.assertEqual(ut[0].get("decision_reason"), "unknown_client")

    def test_execute_requires_matching_admit_receipt_id(self) -> None:
        proposal = {
            "capability": "execute.kernel_bridge",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "intent-exec",
            "payload": {"x": 1},
        }
        register_f = {
            "op": "register",
            "client_id": "cid-cap",
            "plugin": "http",
            "adapter_id": "pilot-http",
            "declared_capabilities": ["execute.kernel_bridge"],
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
            r1 = _sr(s, admit_f)
            self.assertTrue(r1.get("ok"))
            ticket = r1["admit_ticket"]
            r2 = _sr(
                s,
                {
                    "op": "execute",
                    "admit_ticket": ticket,
                    "admit_receipt_id": "wrong-not-admit-receipt",
                    "proposal": proposal,
                    "envelope": {"intentId": "intent-exec", "payload": proposal["payload"]},
                },
            )
        self.assertFalse(r2.get("ok"))
        self.assertEqual(r2.get("error"), "execute_not_admitted")
        killed = [r for r in self._receipts() if r.get("decision") == "killed"]
        self.assertTrue(any(r.get("decision_reason") == "policy_violation" for r in killed))

    def test_execute_missing_admit_receipt_id_kills(self) -> None:
        proposal = {
            "capability": "execute.kernel_bridge",
            "capability_version": "1.0.0",
            "from_module": "adapters/http/adapter",
            "to_module": "kernel/runner",
            "intent_id": "intent-exec2",
            "payload": {},
        }
        register_f = {
            "op": "register",
            "client_id": "cid-cap",
            "plugin": "http",
            "adapter_id": "pilot-http",
            "declared_capabilities": ["execute.kernel_bridge"],
            "adapter_bundle_hash": self._bundle_hash,
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
            r1 = _sr(
                s,
                {"op": "admit", "constitution_id": "zak-default", "proposal": proposal},
            )
            self.assertTrue(r1.get("ok"))
            ticket = r1["admit_ticket"]
            r2 = _sr(
                s,
                {
                    "op": "execute",
                    "admit_ticket": ticket,
                    "proposal": proposal,
                    "envelope": {"intentId": "intent-exec2", "payload": {}},
                },
            )
        self.assertFalse(r2.get("ok"))
        self.assertEqual(r2.get("error"), "execute_malformed")

    def test_missing_capability_version_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
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
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "no-ver",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "missing_capability_version")
        rid = replies[1].get("receipt_id")
        rec = next(r for r in self._receipts() if r.get("receipt_id") == rid)
        self.assertEqual(rec.get("decision_reason"), "policy_violation")
        self.assertEqual(rec.get("detail"), "capability_version_missing")

    def test_capability_version_not_in_snapshot_rejected(self) -> None:
        frames = [
            {
                "op": "register",
                "client_id": "cid-cap",
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
                    "capability_version": "99.0.0",
                    "from_module": "adapters/http/adapter",
                    "to_module": "kernel/runner",
                    "intent_id": "bad-ver",
                    "payload": {},
                },
            },
        ]
        replies = _chat(self._port, frames)
        self.assertEqual(replies[1].get("ok"), False)
        self.assertEqual(replies[1].get("error"), "capability_version_not_in_snapshot")


if __name__ == "__main__":
    unittest.main()
