"""Mandatory execution receipts: deterministic fields, hash chaining, stdout sink."""

from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
from enum import Enum
from typing import Any, Mapping

_CHAIN_LOCK = threading.Lock()
_CHAIN_HEAD = ""


class DecisionReason(str, Enum):
    """Explicit classification for proxy observability (replaces string sniffing)."""

    CAPABILITY_VIOLATION = "capability_violation"
    POLICY_VIOLATION = "policy_violation"
    ADVERSARIAL = "adversarial"
    UNKNOWN_CLIENT = "unknown_client"


def canonical_json_bytes(obj: Any) -> bytes:
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def derive_receipt_id(parent_receipt: str, body_for_chain: Mapping[str, Any]) -> str:
    payload = {"parent": parent_receipt, **dict(body_for_chain)}
    return sha256_hex(canonical_json_bytes(payload))


class ReceiptSink:
    def __init__(self, stream: Any = None) -> None:
        self._stream = stream or sys.stdout
        self._lock = threading.Lock()

    def emit(self, receipt: dict[str, Any]) -> dict[str, Any]:
        line = json.dumps(receipt, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()
        return receipt


def next_receipt(
    *,
    adapter_id: str | None,
    capability: str,
    input_hash: str,
    policy_hash: str,
    decision: str,
    decision_reason: DecisionReason | None,
    parent_receipt: str | None = None,
    trusted: bool = True,
    capability_valid: bool = True,
    client_id: str | None = None,
    constitution_id: str | None = None,
    context_present: bool = False,
    extra: dict[str, Any] | None = None,
    memory_scope: str | None = None,
    memory_operation: str | None = None,
    capability_version: str | None = None,
    capability_definition_hash: str | None = None,
    capability_definition_hash_mode: str | None = None,
) -> dict[str, Any]:
    """Advance chain head; parent defaults to previous global receipt."""
    global _CHAIN_HEAD
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with _CHAIN_LOCK:
        parent = parent_receipt if parent_receipt is not None else _CHAIN_HEAD
        core: dict[str, Any] = {
            "trusted": trusted,
            "adapter_id": adapter_id,
            "capability": capability,
            "input_hash": input_hash,
            "policy_hash": policy_hash,
            "timestamp": ts,
            "decision": decision,
            "capability_valid": capability_valid,
            "decision_reason": decision_reason.value if decision_reason is not None else None,
            "context_present": context_present,
        }
        if client_id is not None:
            core["client_id"] = client_id
        if extra:
            core.update(extra)
        if constitution_id is not None:
            core["constitution_id"] = constitution_id
        if memory_scope is not None:
            core["memory_scope"] = memory_scope
        if memory_operation is not None:
            core["memory_operation"] = memory_operation
        if capability_version is not None:
            core["capability_version"] = capability_version
        if capability_definition_hash is not None:
            core["capability_definition_hash"] = capability_definition_hash
        if capability_definition_hash_mode is not None:
            core["capability_definition_hash_mode"] = capability_definition_hash_mode
        rid = derive_receipt_id(parent, core)
        receipt: dict[str, Any] = {"receipt_id": rid, "parent_receipt": parent, **core}
        _CHAIN_HEAD = rid
        return receipt


def get_chain_head() -> str:
    with _CHAIN_LOCK:
        return _CHAIN_HEAD


def set_chain_head(receipt_id: str) -> None:
    global _CHAIN_HEAD
    with _CHAIN_LOCK:
        _CHAIN_HEAD = receipt_id


def proposal_input_hash(proposal: Mapping[str, Any]) -> str:
    """Hash of structured proposal (admission stub)."""
    return sha256_hex(canonical_json_bytes(dict(proposal)))
