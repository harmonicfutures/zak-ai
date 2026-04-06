"""
Constitutional membrane: admission, enforcement, receipts, Gold execute.
Engine supplies paths and measurements only — all governance decisions here.
"""

from __future__ import annotations

import json
import os
import secrets
import socketserver
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Tuple

from capability_snapshot import (
    CapabilitySnapshot,
    effective_definition_hash_mode,
    load_capability_snapshot,
    verify_capability_definition_hash_field,
    verify_capability_version_field,
)
from constitution_resolver import ConstitutionResolver, ResolvedConstitution
from gold_bridge import invoke_gold
from receipts import DecisionReason, ReceiptSink, next_receipt, proposal_input_hash

RegisteredClient = Tuple[subprocess.Popen, str, str]  # proc, plugin, adapter_id oracle


@dataclass(frozen=True)
class ProxyPolicy:
    allowlist: frozenset[tuple[str, str]]
    node_ids: frozenset[str]
    untrusted_plugin_names: frozenset[str]
    capability_scope: dict[str, frozenset[str]]


def load_proxy_policy(map_data: dict[str, Any]) -> ProxyPolicy:
    edges: set[tuple[str, str]] = set()
    for pair in map_data.get("gold_internal", {}).get("edges", []):
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            edges.add((str(pair[0]), str(pair[1])))
    for pair in map_data.get("adapters_internal", {}).get("edges", []):
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            edges.add((str(pair[0]), str(pair[1])))
    proxy_cfg = map_data.get("proxy") or {}
    for item in proxy_cfg.get("allowed_cross_edges", []):
        if isinstance(item, (list, tuple)) and len(item) == 2:
            edges.add((str(item[0]), str(item[1])))
        elif isinstance(item, dict) and "from" in item and "to" in item:
            edges.add((str(item["from"]), str(item["to"])))

    node_ids: set[str] = set()
    for n in map_data.get("gold_internal", {}).get("nodes", []):
        if isinstance(n, dict) and "id" in n:
            node_ids.add(str(n["id"]))
    for n in map_data.get("adapters_internal", {}).get("nodes", []):
        if isinstance(n, dict) and "id" in n:
            node_ids.add(str(n["id"]))

    untrusted = proxy_cfg.get("untrusted_plugin_names") or ["http", "sentry"]
    untrusted_set = frozenset(str(x) for x in untrusted)

    cap_scope: dict[str, frozenset[str]] = {}
    raw_cap = proxy_cfg.get("capability_scope") or {}
    if isinstance(raw_cap, dict):
        for k, v in raw_cap.items():
            if isinstance(v, list):
                cap_scope[str(k)] = frozenset(str(x) for x in v)

    return ProxyPolicy(
        allowlist=frozenset(edges),
        node_ids=frozenset(node_ids),
        untrusted_plugin_names=untrusted_set,
        capability_scope=cap_scope,
    )


def load_proxy_policy_path(map_path: Path) -> ProxyPolicy:
    with map_path.open(encoding="utf-8") as f:
        return load_proxy_policy(json.load(f))


def edge_is_allowed(policy: ProxyPolicy, from_module: str, to_module: str) -> bool:
    if from_module not in policy.node_ids or to_module not in policy.node_ids:
        return False
    return (from_module, to_module) in policy.allowlist


def _admission_context_constitution_id(msg: dict[str, Any]) -> tuple[str | None, str | None, bool]:
    """
    Prefer context.constitution_id; fall back to top-level constitution_id (backward compat).
    Returns (constitution_id, error_code, context_present) where context_present means
    ``context`` was provided as a JSON object.
    """
    raw_ctx = msg.get("context")
    context_present = isinstance(raw_ctx, dict)
    if raw_ctx is not None and not isinstance(raw_ctx, dict):
        return None, "context_not_object", False
    cid_ctx: str | None = None
    if isinstance(raw_ctx, dict):
        v = raw_ctx.get("constitution_id")
        if isinstance(v, str) and v.strip():
            cid_ctx = v.strip()
    top = msg.get("constitution_id")
    top_s = top.strip() if isinstance(top, str) and top.strip() else None
    if cid_ctx and top_s and cid_ctx != top_s:
        return None, "constitution_id_mismatch", context_present
    cid = cid_ctx or top_s
    return cid, None, context_present


def _validate_context_passthrough_shape(ctx: dict[str, Any]) -> str | None:
    """tags / metadata shape only; other keys ignored (passthrough)."""
    if "tags" in ctx and ctx["tags"] is not None:
        t = ctx["tags"]
        if not isinstance(t, list) or not all(isinstance(x, str) for x in t):
            return "context_tags_invalid"
    if "metadata" in ctx and ctx["metadata"] is not None:
        m = ctx["metadata"]
        if not isinstance(m, dict):
            return "context_metadata_invalid"
        for k, v in m.items():
            if not isinstance(k, str):
                return "context_metadata_invalid"
            if isinstance(v, (dict, list)):
                return "context_metadata_not_shallow"
    return None


MEMORY_SCOPE_MAX_LEN = 256

_MEMORY_SCOPE_CLIENT_ERROR: dict[str, str] = {
    "memory_scope_missing": "memory_scope_invalid",
    "memory_scope_invalid_type": "memory_scope_invalid",
    "memory_scope_empty": "memory_scope_invalid",
    "memory_scope_too_long": "memory_scope_too_long",
}

_CAPABILITY_VERSION_CLIENT_ERROR: dict[str, str] = {
    "capability_version_missing": "missing_capability_version",
    "capability_version_invalid": "invalid_capability_version",
    "capability_version_not_in_snapshot": "capability_version_not_in_snapshot",
}

_CAPABILITY_DEF_HASH_CLIENT_ERROR: dict[str, str] = {
    "capability_definition_hash_invalid": "invalid_capability_definition_hash",
    "capability_definition_hash_malformed": "malformed_capability_definition_hash",
    "capability_definition_hash_mismatch": "capability_definition_hash_mismatch",
}


def _receipt_capability_version(proposal: dict[str, Any]) -> str | None:
    v = proposal.get("capability_version")
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def _receipt_capability_definition_hash(proposal: dict[str, Any]) -> str | None:
    """Passthrough for receipts only; admission path validates format and pins separately."""
    v = proposal.get("capability_definition_hash")
    return v if isinstance(v, str) else None


def _memory_operation_for_capability(capability: str) -> str | None:
    if capability == "memory.read":
        return "read"
    if capability == "memory.write":
        return "write"
    return None


def _normalize_memory_scope(
    capability: str, proposal: dict[str, Any]
) -> tuple[str | None, str | None]:
    """
    For memory.* : validate payload.memory_scope (non-empty after trim, max length).
    Returns (normalized_scope, None) or (None, detail_code). Non-memory → (None, None).
    """
    if capability not in ("memory.read", "memory.write"):
        return None, None
    pl = proposal.get("payload")
    if not isinstance(pl, dict) or "memory_scope" not in pl:
        return None, "memory_scope_missing"
    v = pl.get("memory_scope")
    if not isinstance(v, str):
        return None, "memory_scope_invalid_type"
    s = v.strip()
    if not s:
        return None, "memory_scope_empty"
    if len(s) > MEMORY_SCOPE_MAX_LEN:
        return None, "memory_scope_too_long"
    return s, None


@dataclass
class _Session:
    """Post-registration binding: adapter_id, bundle hash, allowed capabilities only."""

    adapter_id: str
    allowed_capabilities: frozenset[str]
    bundle_hash: str
    plugin: str


@dataclass
class _AdmitTicket:
    client_id: str
    adapter_id: str
    input_hash: str
    policy_hash: str
    capability: str
    constitution_id: str
    admit_receipt_id: str
    created_at_utc: str
    expires_at_monotonic: float


class KernelCallProxy:
    """
    Constitutional proxy: register → admit → execute (Gold). No bare invoke.
    """

    def __init__(
        self,
        policy: ProxyPolicy,
        *,
        resolver: ConstitutionResolver,
        gold_root: Path,
        dependency_map_path: Path,
        expected_bundle_hashes: dict[str, str],
        adapter_id_oracles: dict[str, str],
        capability_snapshot: CapabilitySnapshot,
        receipt_sink: ReceiptSink | None = None,
        log: Callable[..., None] | None = None,
        on_adapter_killed: Callable[[str, str], None] | None = None,
        adversarial_mode: bool = False,
        admit_ticket_ttl_sec: float = 120.0,
    ) -> None:
        self._policy = policy
        self._resolver = resolver
        self._gold_root = gold_root.resolve()
        self._dependency_map_path = dependency_map_path
        norm = []
        for k, v in expected_bundle_hashes.items():
            s = str(v).lower()
            if not s.startswith("sha256:"):
                s = f"sha256:{s}"
            norm.append((k, s))
        self._expected_bundle_hashes = dict(norm)
        oracles = []
        for k, v in adapter_id_oracles.items():
            oracles.append((k, str(v)))
        self._adapter_id_oracles = dict(oracles)
        self._capability_snapshot = capability_snapshot
        self._receipts = receipt_sink or ReceiptSink()
        self._log = log or (lambda *msg: print(*msg, file=sys.stderr))
        self._on_adapter_killed = on_adapter_killed
        self._adversarial_mode = adversarial_mode
        self._admit_ticket_ttl_sec = float(admit_ticket_ttl_sec)
        self._lock = threading.Lock()
        self._registry: Dict[str, RegisteredClient] = {}
        self._ticket_lock = threading.Lock()
        self._admit_tickets: dict[str, _AdmitTicket] = {}
        self._tickets_by_client: dict[str, set[str]] = {}
        self._server: socketserver.ThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None

    def _policy_hash_or_unknown(self) -> str:
        try:
            return self._resolver.resolve("zak-default").policy_hash
        except Exception:
            return "sha256:unknown"

    def _emit_gov(
        self,
        event: str,
        *,
        client_id: str | None,
        adapter_id: str | None,
        policy_hash: str | None = None,
        decision_reason: str | None = None,
        **more: Any,
    ) -> None:
        payload: dict[str, Any] = {
            "gov": event,
            "client_id": client_id,
            "adapter_id": adapter_id,
        }
        if policy_hash is not None and policy_hash != "sha256:unknown":
            payload["policy_hash"] = policy_hash
        if decision_reason is not None:
            payload["decision_reason"] = decision_reason
        if more:
            payload.update(more)
        self._log(json.dumps(payload, sort_keys=True))

    @property
    def untrusted_plugin_names(self) -> frozenset[str]:
        return self._policy.untrusted_plugin_names

    def register_client(
        self, client_id: str, proc: subprocess.Popen, plugin_name: str, adapter_id_oracle: str
    ) -> None:
        with self._lock:
            self._registry[client_id] = (proc, plugin_name, adapter_id_oracle)

    def unregister_client(self, client_id: str) -> None:
        with self._lock:
            self._registry.pop(client_id, None)

    def invalidate_all_admit_tickets(self) -> None:
        with self._ticket_lock:
            self._admit_tickets.clear()
            self._tickets_by_client.clear()
        self._emit_gov(
            "admit_tickets_invalidated",
            client_id=None,
            adapter_id=None,
            scope="all",
        )

    def invalidate_client_admit_tickets(self, client_id: str) -> None:
        with self._ticket_lock:
            keys = set(self._tickets_by_client.pop(client_id, set()))
            for k in keys:
                self._admit_tickets.pop(k, None)
        self._emit_gov(
            "admit_tickets_invalidated",
            client_id=client_id,
            adapter_id=None,
            scope="client",
        )

    def _kill_client_subprocess(
        self,
        client_id: str,
        reason: str,
        *,
        decision_reason: DecisionReason | None = None,
    ) -> None:
        with self._lock:
            entry = self._registry.pop(client_id, None)
        sess = getattr(self, "_last_sessions", {}).get(client_id)  # type: ignore[attr-defined]
        adapter_id = sess.adapter_id if sess else None
        cap = "violation"
        policy_h = "sha256:unknown"
        try:
            rc = self._resolver.resolve("zak-default")
            policy_h = rc.policy_hash
        except Exception:
            pass
        if decision_reason is None:
            decision_reason = (
                DecisionReason.ADVERSARIAL
                if "adversarial" in reason.lower()
                else DecisionReason.POLICY_VIOLATION
            )
        ih = proposal_input_hash({"kill_reason": reason})
        rec = next_receipt(
            adapter_id=adapter_id,
            capability=cap,
            input_hash=ih,
            policy_hash=policy_h,
            decision="killed",
            decision_reason=decision_reason,
            trusted=bool(sess),
            capability_valid=True,
            client_id=client_id,
            extra={"kill_reason": reason},
        )
        self._receipts.emit(rec)
        proc, plugin_name, _ = entry if entry else (None, None, None)
        self._emit_gov(
            "violation",
            client_id=client_id,
            adapter_id=adapter_id,
            policy_hash=policy_h if policy_h != "sha256:unknown" else None,
            decision_reason=decision_reason.value,
            kill_reason=reason,
            plugin=plugin_name,
        )
        if not entry:
            if self._on_adapter_killed is not None:
                try:
                    self._on_adapter_killed(client_id, reason)
                except Exception:
                    pass
            return
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        if self._on_adapter_killed is not None:
            try:
                self._on_adapter_killed(client_id, reason)
            except Exception:
                pass

    def _validate_plugin_name(self, plugin_name: str) -> bool:
        return plugin_name in self._policy.untrusted_plugin_names

    def _emit_receipt(self, r: dict[str, Any]) -> None:
        self._receipts.emit(r)

    def start_listener(self, host: str, port: int) -> None:
        if self._server is not None:
            raise RuntimeError("proxy listener already started")

        proxy = self
        last_sessions: dict[str, _Session] = {}
        setattr(proxy, "_last_sessions", last_sessions)

        class _TCPHandler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                cid: str | None = None
                sess: _Session | None = None
                rfile = self.rfile
                wfile = self.wfile

                def write_obj(obj: dict[str, Any]) -> None:
                    wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
                    wfile.flush()

                while True:
                    line = rfile.readline()
                    if not line:
                        if cid:
                            proxy.invalidate_client_admit_tickets(cid)
                        break
                    try:
                        msg = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        if cid:
                            proxy._kill_client_subprocess(
                                cid, "non-JSON or malformed frame after registration"
                            )
                        return

                    if not isinstance(msg, dict):
                        if cid:
                            proxy._kill_client_subprocess(cid, "message is not a JSON object")
                        return

                    op = msg.get("op")

                    if cid is None:
                        if op != "register":
                            write_obj({"ok": False, "error": "first frame must be op=register"})
                            return
                        reg_id = msg.get("client_id")
                        reg_plugin = msg.get("plugin")
                        adapter_id = msg.get("adapter_id")
                        caps_raw = msg.get("declared_capabilities")
                        bundle_hash = msg.get("adapter_bundle_hash")
                        if (
                            not isinstance(reg_id, str)
                            or not isinstance(reg_plugin, str)
                            or not isinstance(adapter_id, str)
                            or not isinstance(bundle_hash, str)
                            or not isinstance(caps_raw, list)
                        ):
                            write_obj({"ok": False, "error": "register attestation incomplete"})
                            return
                        caps = frozenset(str(c) for c in caps_raw if c)
                        ph_reg = proxy._policy_hash_or_unknown()
                        if not caps:
                            write_obj({"ok": False, "error": "declared_capabilities required"})
                            return
                        exp = proxy._expected_bundle_hashes.get(reg_plugin, "")
                        if reg_plugin not in proxy._expected_bundle_hashes:
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {"kind": "register", "reject": "no_bundle_oracle", "plugin": reg_plugin}
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="no_bundle_oracle",
                            )
                            write_obj(
                                {"ok": False, "error": "no_bundle_oracle", "receipt_id": rec["receipt_id"]}
                            )
                            return
                        if bundle_hash.lower() != exp:
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {
                                        "kind": "register",
                                        "reject": "bundle_mismatch",
                                        "expected": exp,
                                        "got": bundle_hash.lower(),
                                    }
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="bundle_mismatch",
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "bundle attestation failed",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            return
                        scope = proxy._policy.capability_scope.get(reg_plugin, frozenset())
                        if not scope:
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {"kind": "register", "reject": "unknown_plugin_scope", "plugin": reg_plugin}
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="unknown_plugin_scope",
                            )
                            write_obj(
                                {"ok": False, "error": "unknown plugin scope", "receipt_id": rec["receipt_id"]}
                            )
                            return
                        if not caps.issubset(scope):
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {
                                        "kind": "register",
                                        "reject": "capability_escalation",
                                        "declared": sorted(caps),
                                        "allowed_scope": sorted(scope),
                                    }
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.CAPABILITY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.CAPABILITY_VIOLATION.value,
                                detail="capability_escalation",
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "capability not in scope",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            return
                        with proxy._lock:
                            slot = proxy._registry.get(reg_id)
                        if slot is None:
                            rec = next_receipt(
                                adapter_id=None,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {
                                        "kind": "register",
                                        "reject": "unknown_client",
                                        "claimed_adapter_id": adapter_id,
                                    }
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.UNKNOWN_CLIENT,
                                trusted=False,
                                capability_valid=False,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "untrusted_registration",
                                client_id=reg_id,
                                adapter_id=None,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.UNKNOWN_CLIENT.value,
                                receipt_id=rec["receipt_id"],
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "unknown client_id",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            return
                        _proc, expected_plugin, expected_adapter_id = slot
                        if adapter_id != expected_adapter_id:
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {
                                        "kind": "register",
                                        "reject": "adapter_id_mismatch",
                                        "expected": expected_adapter_id,
                                        "got": adapter_id,
                                    }
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="adapter_id_mismatch",
                            )
                            write_obj(
                                {"ok": False, "error": "adapter_id mismatch", "receipt_id": rec["receipt_id"]}
                            )
                            return
                        if expected_plugin != reg_plugin:
                            rec = next_receipt(
                                adapter_id=adapter_id,
                                capability="registration",
                                input_hash=proposal_input_hash(
                                    {
                                        "kind": "register",
                                        "reject": "plugin_mismatch",
                                        "expected": expected_plugin,
                                        "got": reg_plugin,
                                    }
                                ),
                                policy_hash=ph_reg,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=reg_id,
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "register_rejected",
                                client_id=reg_id,
                                adapter_id=adapter_id,
                                policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="plugin_mismatch",
                            )
                            write_obj(
                                {"ok": False, "error": "plugin mismatch", "receipt_id": rec["receipt_id"]}
                            )
                            return
                        if not proxy._validate_plugin_name(reg_plugin):
                            write_obj({"ok": False, "error": "plugin is not an untrusted proxy client"})
                            return
                        cid = reg_id
                        sess = _Session(
                            adapter_id=adapter_id,
                            allowed_capabilities=caps,
                            bundle_hash=bundle_hash.lower(),
                            plugin=reg_plugin,
                        )
                        last_sessions[cid] = sess
                        proxy._emit_gov(
                            "adapter_registered",
                            client_id=cid,
                            adapter_id=adapter_id,
                            policy_hash=ph_reg if ph_reg != "sha256:unknown" else None,
                            plugin=reg_plugin,
                            bundle_hash=bundle_hash.lower(),
                            allowed_capabilities=sorted(caps),
                        )
                        write_obj({"ok": True, "registered": True, "membrane": "constitutional-v1"})
                        continue

                    if sess is None or cid is None:
                        return

                    if op == "invoke":
                        proxy._kill_client_subprocess(cid, "bare invoke forbidden — use admit then execute")
                        write_obj({"ok": False, "error": "invoke_bypass_denied"})
                        return

                    if op == "admit":
                        proposal = msg.get("proposal")
                        claim = msg.get("policy_hash_claim")
                        if not isinstance(proposal, dict):
                            proxy._kill_client_subprocess(cid, "admit malformed")
                            write_obj({"ok": False, "error": "admit_malformed"})
                            return
                        constitution_id, ctx_err, context_present = _admission_context_constitution_id(
                            msg
                        )
                        ctx_obj = msg["context"] if isinstance(msg.get("context"), dict) else None
                        if ctx_obj is not None:
                            shape_err = _validate_context_passthrough_shape(ctx_obj)
                            if shape_err is not None:
                                proxy._kill_client_subprocess(
                                    cid,
                                    f"admission context shape invalid: {shape_err}",
                                    decision_reason=DecisionReason.POLICY_VIOLATION,
                                )
                                write_obj({"ok": False, "error": shape_err})
                                return
                        if ctx_err == "context_not_object":
                            proxy._kill_client_subprocess(
                                cid,
                                "admit context must be a JSON object when provided",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                            )
                            write_obj({"ok": False, "error": "context_invalid"})
                            return
                        if ctx_err == "constitution_id_mismatch":
                            ph = proxy._policy_hash_or_unknown()
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability="admission",
                                input_hash=proposal_input_hash(
                                    {
                                        "reject": "constitution_id_mismatch",
                                        "proposal": proposal,
                                    }
                                ),
                                policy_hash=ph,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=cid,
                                constitution_id=None,
                                context_present=context_present,
                                extra={"detail": "constitution_id_mismatch"},
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                policy_hash=ph if ph != "sha256:unknown" else None,
                                constitution_id=None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="constitution_id_mismatch",
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "constitution_id_mismatch",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        if not constitution_id:
                            ph = proxy._policy_hash_or_unknown()
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability="admission",
                                input_hash=proposal_input_hash(
                                    {"reject": "missing_constitution_id", "partial": True}
                                ),
                                policy_hash=ph,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=cid,
                                constitution_id=None,
                                context_present=context_present,
                                extra={"detail": "missing_constitution_id"},
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                policy_hash=ph if ph != "sha256:unknown" else None,
                                constitution_id=None,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail="missing_constitution_id",
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "missing_constitution_id",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        try:
                            resolved: ResolvedConstitution = proxy._resolver.resolve(constitution_id)
                        except Exception as e:
                            proxy._kill_client_subprocess(cid, f"constitution resolve failed: {e}")
                            write_obj({"ok": False, "error": "constitution_invalid"})
                            return
                        if isinstance(claim, str) and claim:
                            proxy._emit_gov(
                                "adapter_policy_hash_claim",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                constitution_id=resolved.constitution_id,
                                policy_hash=resolved.policy_hash,
                                claim=claim,
                            )
                        cap = proposal.get("capability")
                        from_m = proposal.get("from_module")
                        to_m = proposal.get("to_module")
                        intent_id = proposal.get("intent_id")
                        if "payload" not in proposal:
                            proxy._kill_client_subprocess(cid, "proposal missing payload")
                            write_obj({"ok": False, "error": "proposal_no_payload"})
                            return
                        if (
                            not isinstance(cap, str)
                            or not isinstance(from_m, str)
                            or not isinstance(to_m, str)
                            or not isinstance(intent_id, str)
                        ):
                            proxy._kill_client_subprocess(cid, "proposal schema invalid")
                            write_obj({"ok": False, "error": "proposal_invalid"})
                            return
                        mem_op = _memory_operation_for_capability(cap)
                        cap_ver, cv_err = verify_capability_version_field(
                            proposal, proxy._capability_snapshot, cap
                        )
                        if cv_err:
                            input_hash = proposal_input_hash(proposal)
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability=cap,
                                input_hash=input_hash,
                                policy_hash=resolved.policy_hash,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=cid,
                                constitution_id=resolved.constitution_id,
                                context_present=context_present,
                                memory_operation=mem_op,
                                extra={"detail": cv_err},
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                constitution_id=resolved.constitution_id,
                                policy_hash=resolved.policy_hash,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail=cv_err,
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": _CAPABILITY_VERSION_CLIENT_ERROR[cv_err],
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        # Invariant: capability_definition_hash is host-asserted identity.
                        # The membrane MUST treat it as opaque: validate format, record, and optionally
                        # compare to a pinned value. It MUST NOT recompute or normalize from any local
                        # definition source. Dual digests create ambiguity, not safety.
                        #
                        # Presence semantics are binary and global:
                        # - Absent: no identity asserted (allowed, unless policy requires otherwise).
                        # - Present: exact value must be well-formed and, if a pin exists for the
                        #   (capability, version) pair, MUST match that pin (fail closed on mismatch).
                        #
                        # No capability-specific exceptions. Do not branch on "safe" capabilities.
                        def_hash, dh_err = verify_capability_definition_hash_field(
                            proposal, proxy._capability_snapshot, cap, cap_ver
                        )
                        if dh_err:
                            input_hash = proposal_input_hash(proposal)
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability=cap,
                                input_hash=input_hash,
                                policy_hash=resolved.policy_hash,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=cid,
                                constitution_id=resolved.constitution_id,
                                context_present=context_present,
                                memory_operation=mem_op,
                                capability_version=cap_ver,
                                extra={"detail": dh_err},
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                constitution_id=resolved.constitution_id,
                                policy_hash=resolved.policy_hash,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail=dh_err,
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": _CAPABILITY_DEF_HASH_CLIENT_ERROR[dh_err],
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        norm_scope, ms_err = _normalize_memory_scope(cap, proposal)
                        if ms_err:
                            input_hash = proposal_input_hash(proposal)
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability=cap,
                                input_hash=input_hash,
                                policy_hash=resolved.policy_hash,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=cid,
                                constitution_id=resolved.constitution_id,
                                context_present=context_present,
                                memory_operation=mem_op,
                                capability_version=cap_ver,
                                capability_definition_hash=def_hash,
                                capability_definition_hash_mode=effective_definition_hash_mode(
                                    proxy._capability_snapshot, cap, cap_ver, def_hash
                                ),
                                extra={"detail": ms_err},
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                constitution_id=resolved.constitution_id,
                                policy_hash=resolved.policy_hash,
                                decision_reason=DecisionReason.POLICY_VIOLATION.value,
                                detail=ms_err,
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": _MEMORY_SCOPE_CLIENT_ERROR[ms_err],
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        if cap not in sess.allowed_capabilities:
                            input_hash = proposal_input_hash(proposal)
                            rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability=cap,
                                input_hash=input_hash,
                                policy_hash=resolved.policy_hash,
                                decision="rejected",
                                decision_reason=DecisionReason.CAPABILITY_VIOLATION,
                                trusted=True,
                                capability_valid=False,
                                client_id=cid,
                                constitution_id=resolved.constitution_id,
                                context_present=context_present,
                                memory_scope=norm_scope,
                                memory_operation=mem_op,
                                capability_version=cap_ver,
                                capability_definition_hash=def_hash,
                                capability_definition_hash_mode=effective_definition_hash_mode(
                                    proxy._capability_snapshot, cap, cap_ver, def_hash
                                ),
                                extra={
                                    "allowed_capabilities": sorted(sess.allowed_capabilities),
                                },
                            )
                            proxy._emit_receipt(rec)
                            proxy._emit_gov(
                                "admit_rejected",
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                constitution_id=resolved.constitution_id,
                                policy_hash=resolved.policy_hash,
                                decision_reason=DecisionReason.CAPABILITY_VIOLATION.value,
                                detail="capability_denied",
                            )
                            write_obj(
                                {
                                    "ok": False,
                                    "error": "capability_denied",
                                    "receipt_id": rec["receipt_id"],
                                }
                            )
                            continue
                        if not edge_is_allowed(proxy._policy, from_m, to_m):
                            proxy._kill_client_subprocess(
                                cid, f"edge not allowed: {from_m!r} -> {to_m!r}"
                            )
                            write_obj({"ok": False, "error": "edge_denied"})
                            return
                        if proxy._adversarial_mode:
                            if cap.endswith(".evil") or "malformed" in json.dumps(proposal):
                                proxy._kill_client_subprocess(
                                    cid,
                                    "adversarial tripwire",
                                    decision_reason=DecisionReason.ADVERSARIAL,
                                )
                                write_obj({"ok": False, "error": "adversarial"})
                                return
                        input_hash = proposal_input_hash(proposal)
                        rec = next_receipt(
                            adapter_id=sess.adapter_id,
                            capability=cap,
                            input_hash=input_hash,
                            policy_hash=resolved.policy_hash,
                            decision="admitted",
                            decision_reason=None,
                            trusted=True,
                            capability_valid=True,
                            client_id=cid,
                            constitution_id=resolved.constitution_id,
                            context_present=context_present,
                            memory_scope=norm_scope,
                            memory_operation=mem_op,
                            capability_version=cap_ver,
                            capability_definition_hash=def_hash,
                            capability_definition_hash_mode=effective_definition_hash_mode(
                                proxy._capability_snapshot, cap, cap_ver, def_hash
                            ),
                            extra={"from_module": from_m, "to_module": to_m},
                        )
                        proxy._emit_receipt(rec)
                        proxy._emit_gov(
                            "admit_ok",
                            client_id=cid,
                            adapter_id=sess.adapter_id,
                            constitution_id=resolved.constitution_id,
                            policy_hash=resolved.policy_hash,
                            admit_receipt_id=rec["receipt_id"],
                            capability_definition_hash_mode=effective_definition_hash_mode(
                                proxy._capability_snapshot, cap, cap_ver, def_hash
                            ),
                        )
                        ticket = secrets.token_hex(16)
                        now_wall = time.time()
                        now_m = time.monotonic()
                        ttl = proxy._admit_ticket_ttl_sec
                        created_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_wall))
                        expires_utc = time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_wall + ttl)
                        )
                        with proxy._ticket_lock:
                            proxy._admit_tickets[ticket] = _AdmitTicket(
                                client_id=cid,
                                adapter_id=sess.adapter_id,
                                input_hash=input_hash,
                                policy_hash=resolved.policy_hash,
                                capability=cap,
                                constitution_id=resolved.constitution_id,
                                admit_receipt_id=rec["receipt_id"],
                                created_at_utc=created_utc,
                                expires_at_monotonic=now_m + ttl,
                            )
                            proxy._tickets_by_client.setdefault(cid, set()).add(ticket)
                        write_obj(
                            {
                                "ok": True,
                                "admitted": True,
                                "admit_ticket": ticket,
                                "admit_receipt_id": rec["receipt_id"],
                                "policy_hash": resolved.policy_hash,
                                "input_hash": input_hash,
                                "admit_ticket_created_at": created_utc,
                                "admit_ticket_expires_at": expires_utc,
                                "admit_ticket_ttl_sec": ttl,
                            }
                        )
                        continue

                    if op == "execute":
                        ticket = msg.get("admit_ticket")
                        admit_rid = msg.get("admit_receipt_id")
                        proposal = msg.get("proposal")
                        envelope = msg.get("envelope")
                        if (
                            not isinstance(ticket, str)
                            or not isinstance(admit_rid, str)
                            or not isinstance(proposal, dict)
                            or not isinstance(envelope, dict)
                        ):
                            proxy._kill_client_subprocess(
                                cid,
                                "execute malformed or missing admit_receipt_id",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                            )
                            write_obj({"ok": False, "error": "execute_malformed"})
                            return
                        with proxy._ticket_lock:
                            ticket_rec = proxy._admit_tickets.pop(ticket, None)
                        if (
                            ticket_rec is None
                            or ticket_rec.client_id != cid
                            or ticket_rec.input_hash != proposal_input_hash(proposal)
                            or ticket_rec.admit_receipt_id != admit_rid
                        ):
                            proxy._kill_client_subprocess(
                                cid,
                                "execute admit ticket invalid, replay, or admit_receipt_id mismatch",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                            )
                            write_obj({"ok": False, "error": "execute_not_admitted"})
                            return
                        if envelope.get("intentId") != proposal.get("intent_id"):
                            proxy._kill_client_subprocess(cid, "envelope intent mismatch")
                            write_obj({"ok": False, "error": "envelope_mismatch"})
                            return
                        if json.dumps(envelope.get("payload"), sort_keys=True, default=str) != json.dumps(
                            proposal["payload"], sort_keys=True, default=str
                        ):
                            proxy._kill_client_subprocess(cid, "envelope payload mismatch")
                            write_obj({"ok": False, "error": "payload_mismatch"})
                            return
                        corr = "proxy"
                        if isinstance(msg.get("context"), dict) and isinstance(
                            msg["context"].get("correlation_id"), str
                        ):
                            corr = msg["context"]["correlation_id"]
                        exec_mem_op = _memory_operation_for_capability(ticket_rec.capability)
                        exec_norm_scope, exec_ms_err = _normalize_memory_scope(
                            ticket_rec.capability, proposal
                        )
                        exec_cv = _receipt_capability_version(proposal)
                        exec_dh = _receipt_capability_definition_hash(proposal)
                        if exec_ms_err:
                            exec_rec = next_receipt(
                                adapter_id=sess.adapter_id,
                                capability=ticket_rec.capability,
                                input_hash=ticket_rec.input_hash,
                                policy_hash=ticket_rec.policy_hash,
                                decision="rejected",
                                decision_reason=DecisionReason.POLICY_VIOLATION,
                                trusted=True,
                                capability_valid=True,
                                client_id=cid,
                                constitution_id=ticket_rec.constitution_id,
                                context_present=False,
                                memory_operation=exec_mem_op,
                                capability_version=exec_cv,
                                capability_definition_hash=exec_dh,
                                capability_definition_hash_mode=effective_definition_hash_mode(
                                    proxy._capability_snapshot,
                                    ticket_rec.capability,
                                    exec_cv,
                                    exec_dh,
                                ),
                                extra={
                                    "detail": exec_ms_err,
                                    "admit_receipt_id": ticket_rec.admit_receipt_id,
                                },
                            )
                            proxy._emit_receipt(exec_rec)
                            write_obj(
                                {
                                    "ok": False,
                                    "executed": True,
                                    "error": _MEMORY_SCOPE_CLIENT_ERROR[exec_ms_err],
                                    "execute_receipt_id": exec_rec["receipt_id"],
                                }
                            )
                            continue
                        gold_out = invoke_gold(proxy._gold_root, envelope, corr)
                        exec_rec = next_receipt(
                            adapter_id=sess.adapter_id,
                            capability=ticket_rec.capability,
                            input_hash=ticket_rec.input_hash,
                            policy_hash=ticket_rec.policy_hash,
                            decision="executed" if gold_out.get("ok") else "rejected",
                            decision_reason=None,
                            trusted=True,
                            capability_valid=True,
                            client_id=cid,
                            constitution_id=ticket_rec.constitution_id,
                            context_present=False,
                            memory_scope=exec_norm_scope,
                            memory_operation=exec_mem_op,
                            capability_version=exec_cv,
                            capability_definition_hash=exec_dh,
                            capability_definition_hash_mode=effective_definition_hash_mode(
                                proxy._capability_snapshot,
                                ticket_rec.capability,
                                exec_cv,
                                exec_dh,
                            ),
                            extra={
                                "gold_ok": bool(gold_out.get("ok")),
                                "admit_receipt_id": ticket_rec.admit_receipt_id,
                            },
                        )
                        proxy._emit_receipt(exec_rec)
                        write_obj(
                            {
                                "ok": bool(gold_out.get("ok")),
                                "executed": True,
                                "gold": gold_out,
                                "execute_receipt_id": exec_rec["receipt_id"],
                            }
                        )
                        continue

                    proxy._kill_client_subprocess(cid, f"unknown op after register: {op!r}")
                    write_obj({"ok": False, "error": "unknown op"})
                    return

        class _Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        server = _Server((host, port), _TCPHandler)
        self._server = server

        def _run() -> None:
            ph_listen: str | None = None
            try:
                ph_listen = self._resolver.resolve("zak-default").policy_hash
            except Exception:
                pass
            self._emit_gov(
                "proxy_listen",
                client_id=None,
                adapter_id=None,
                policy_hash=ph_listen,
                host=host,
                port=port,
            )
            server.serve_forever()

        self._thread = threading.Thread(target=_run, name="constitutional-proxy", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        self._thread = None


def main() -> None:
    import argparse

    from adapter_attestation import sha256_file

    ap = argparse.ArgumentParser(description="standalone constitutional proxy")
    ap.add_argument("map_path", type=Path)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9480)
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument(
        "--attest-bundle",
        type=Path,
        help="Path to adapter dist bundle (e.g. zak-adapters/dist/index.js) for bundle hash oracle",
    )
    ap.add_argument("--attest-plugin", default="http", help="Plugin name key for oracle map")
    ap.add_argument(
        "--attest-adapter-id",
        default="pilot-http",
        help="Expected adapter_id at register (must match client env ZAK_ADAPTER_ID)",
    )
    ap.add_argument("--constitution-id", default="zak-default")
    ap.add_argument(
        "--capability-snapshot",
        type=Path,
        default=None,
        help="JSON allowlist of capability@version (default: sibling of map_path)",
    )
    args = ap.parse_args()
    data = json.loads(args.map_path.read_text(encoding="utf-8"))
    policy = load_proxy_policy(data)
    resolver = ConstitutionResolver()
    try:
        resolver.resolve(args.constitution_id)
    except Exception as e:
        print(f"[proxy] constitution resolve failed (fail-closed): {e}", file=sys.stderr)
        raise SystemExit(2) from e
    if args.attest_bundle and args.attest_bundle.is_file():
        bh = sha256_file(args.attest_bundle)
        expected = {args.attest_plugin: bh}
        oracles = {args.attest_plugin: args.attest_adapter_id}
    else:
        expected = {}
        oracles = {}
        print(
            "[proxy] warning: no --attest-bundle; registration will fail until oracles are set",
            file=sys.stderr,
        )
    adversarial = os.environ.get("ZAK_ADVERSARIAL_MODE") == "1"
    snap_path = args.capability_snapshot or (args.map_path.parent / "capability_snapshot.json")
    exp_snap = os.environ.get("ZAK_CAPABILITY_SNAPSHOT_SHA256")
    cap_snap = load_capability_snapshot(snap_path, expected_sha256=exp_snap or None)
    proxy = KernelCallProxy(
        policy,
        resolver=resolver,
        gold_root=args.gold,
        dependency_map_path=args.map_path,
        expected_bundle_hashes=expected,
        adapter_id_oracles=oracles,
        capability_snapshot=cap_snap,
        adversarial_mode=adversarial,
    )
    proxy.start_listener(args.host, args.port)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        proxy.stop()


if __name__ == "__main__":
    main()
