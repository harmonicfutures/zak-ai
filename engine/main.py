#!/usr/bin/env python3
"""
ZAKAI orchestrator — dumb supervisor only: start/stop processes, liveness,
and graceful_shift(). No policy interpretation; governance is enforced in
engine/proxy.py. Constitution claims are opaque env payloads from
``ConstitutionResolver``, not engine decisions.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

_ENGINE_DIR = Path(__file__).resolve().parent
if str(_ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(_ENGINE_DIR))

from adapter_attestation import sha256_file
from adapters_runtime import AdaptersRuntime
from constitution_resolver import ConstitutionResolver
from gold_runtime import GoldRuntime
from indexer import scan_local_imports
from plugins import NpmAdapterPlugin, create_http_plugin, create_sentry_plugin
from plugins.base import AdapterContext
from project_paths import resolve_roots
from capability_snapshot import load_capability_snapshot
from proxy import KernelCallProxy, load_proxy_policy


def _load_map(engine_dir: Path) -> dict[str, Any]:
    with (engine_dir / "dependency_map.json").open(encoding="utf-8") as f:
        return json.load(f)


def _summarize_graph(data: dict[str, Any]) -> str:
    g = data.get("gold_internal", {})
    a = data.get("adapters_internal", {})
    ge = g.get("edges", [])
    ae = a.get("edges", [])
    lines = [
        "ZAK-Gold internal edges: " + str(len(ge)),
        "ZAK-Adapters internal edges: " + str(len(ae)),
        "Cross-cut: " + json.dumps(data.get("cross_cut", {}), indent=2),
    ]
    return "\n".join(lines)


def _plugin_factories(names: list[str], port: str) -> list[NpmAdapterPlugin]:
    out: list[NpmAdapterPlugin] = []
    for n in names:
        if n == "http":
            out.append(create_http_plugin(port))
        elif n == "sentry":
            out.append(create_sentry_plugin())
        else:
            raise SystemExit(f"Unknown adapter plugin: {n}")
    return out


@dataclass
class ManagedProc:
    """Adapter child process paired with its plugin metadata (for health probes)."""

    proc: subprocess.Popen[str]
    plugin: NpmAdapterPlugin


def _http_health_ok(url: str, timeout: float) -> bool:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return getattr(resp, "status", 200) == 200
    except (urllib.error.URLError, OSError, TimeoutError, ValueError):
        return False


def _fatal_supervision(reason: str) -> None:
    """Hard stop: after Shift, process exits 1 (no auto-restart in this repo)."""
    print(f"[Engine] FATAL: {reason} — exiting with code 1", file=sys.stderr)
    raise SystemExit(1)


def graceful_shift(managed: list[ManagedProc], reason: str) -> None:
    """
    Stop all I/O adapters before kernel-adjacent state is trusted as consistent.
    (Project naming: Shift = controlled state transition.)
    """
    print(f"[Graceful Shift] {reason}", file=sys.stderr)
    for m in managed:
        if m.proc.poll() is None:
            m.proc.send_signal(signal.SIGTERM)
    for m in managed:
        try:
            m.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            m.proc.kill()


def _supervision_loop(
    gold: GoldRuntime,
    managed: list[ManagedProc],
    *,
    heartbeat_sec: float,
    integrity_sec: float,
    health_timeout: float,
    startup_grace_sec: float,
    probe_http: bool,
    periodic_integrity: bool,
    proxy_kill_event: threading.Event | None = None,
    proxy_kill_reason: list[str] | None = None,
) -> None:
    if startup_grace_sec > 0:
        time.sleep(startup_grace_sec)
    last_integrity = time.monotonic()
    print(
        f"Supervision active: heartbeat={heartbeat_sec}s, "
        f"integrity={'off' if not periodic_integrity else f'{integrity_sec}s'}, "
        f"http_probe={probe_http}",
        file=sys.stderr,
    )
    while True:
        if proxy_kill_event is not None:
            if proxy_kill_event.wait(timeout=heartbeat_sec):
                msg = (
                    proxy_kill_reason[0]
                    if proxy_kill_reason
                    else "KernelCallProxy policy violation (adapter killed)"
                )
                graceful_shift(managed, msg)
                _fatal_supervision("post-proxy-kill Shift complete")
        else:
            time.sleep(heartbeat_sec)
        for m in managed:
            code = m.proc.poll()
            if code is not None:
                graceful_shift(managed, f"adapter process exited: {m.plugin.describe()} (exit {code})")
                _fatal_supervision("adapter process exit after Shift")
            url = m.plugin.http_health_url()
            if probe_http and url is not None and not _http_health_ok(url, health_timeout):
                graceful_shift(managed, f"HTTP heartbeat failed for {url} ({m.plugin.describe()})")
                _fatal_supervision("HTTP probe failed after Shift")
        if periodic_integrity and integrity_sec > 0 and (time.monotonic() - last_integrity) >= integrity_sec:
            last_integrity = time.monotonic()
            ok, detail = gold.verify_report()
            if not ok:
                if detail:
                    sys.stderr.write(detail)
                graceful_shift(
                    managed,
                    "ZAK-Gold periodic integrity verify failed — I/O stopped before inconsistent reliance on kernel",
                )
                _fatal_supervision("Gold integrity failed after Shift")


def main() -> None:
    parser = argparse.ArgumentParser(description="ZAKAI engine orchestrator")
    parser.add_argument(
        "--print-graph",
        action="store_true",
        help="Print dependency_map.json summary and exit",
    )
    parser.add_argument(
        "--index-live",
        action="store_true",
        help="Scan TypeScript local imports under Gold and Adapters src/",
    )
    parser.add_argument("--skip-verify", action="store_true", help="Skip npm run verify on Gold")
    parser.add_argument("--skip-build", action="store_true", help="Skip npm run build on both trees")
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip npm install when node_modules is missing",
    )
    parser.add_argument(
        "--adapters",
        default="http",
        help="Comma-separated plugin ids: http,sentry (default: http)",
    )
    parser.add_argument("--port", default="8080", help="PORT for HTTP adapter")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Initialize Gold + Adapters only; do not start adapter processes",
    )
    parser.add_argument(
        "--heartbeat-sec",
        type=float,
        default=10.0,
        help="Interval between adapter liveness / HTTP heartbeat checks (default: 10)",
    )
    parser.add_argument(
        "--integrity-sec",
        type=float,
        default=300.0,
        help="Interval for ZAK-Gold npm verify (0 disables; default: 300)",
    )
    parser.add_argument(
        "--startup-grace-sec",
        type=float,
        default=3.0,
        help="Wait after adapter start before strict health checks (default: 3)",
    )
    parser.add_argument(
        "--health-timeout-sec",
        type=float,
        default=2.0,
        help="Timeout for GET /zak/health (default: 2)",
    )
    parser.add_argument(
        "--no-http-probe",
        action="store_true",
        help="Skip HTTP health checks; only use subprocess liveness",
    )
    parser.add_argument(
        "--kernel-proxy-host",
        default="127.0.0.1",
        help="Host for engine/proxy.py TCP listener (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--kernel-proxy-port",
        type=int,
        default=0,
        help="Port for Adapter→Gold invoke proxy (0 = disabled; non-zero enables dependency_map allowlist)",
    )
    parser.add_argument(
        "--negative-proxy-test",
        action="store_true",
        help="Adversarial proxy/adapters: invalid edges (ZAK_NEGATIVE_EDGE_TEST) + ZAK_ADVERSARIAL_MODE; requires --kernel-proxy-port",
    )
    args = parser.parse_args()

    if args.negative_proxy_test and args.kernel_proxy_port <= 0:
        print(
            "--negative-proxy-test requires --kernel-proxy-port > 0",
            file=sys.stderr,
        )
        raise SystemExit(2)

    data = _load_map(_ENGINE_DIR)
    if args.print_graph:
        print(json.dumps(data, indent=2))
        return

    roots = resolve_roots()
    if args.index_live:
        gold_src = roots.gold / "src"
        ad_src = roots.adapters / "src"
        print("=== Live TS import index (relative) ===")
        print(
            json.dumps(
                {"gold": scan_local_imports(gold_src), "adapters": scan_local_imports(ad_src)},
                indent=2,
            )
        )
        print()
    print(_summarize_graph(data))
    print(f"Gold: {roots.gold}")
    print(f"Adapters: {roots.adapters}")

    gold = GoldRuntime(roots.gold)
    adapters = AdaptersRuntime(roots.adapters)

    if not args.skip_install:
        gold.ensure_dependencies()
        adapters.ensure_dependencies()

    if not args.skip_build:
        gold.build()
        adapters.build()

    if not args.skip_verify:
        gold.verify()

    plugin_names = [x.strip() for x in args.adapters.split(",") if x.strip()]
    plugins = _plugin_factories(plugin_names, args.port)

    ctx = AdapterContext(adapters_root=roots.adapters, gold_root=roots.gold)

    if args.dry_run:
        for p in plugins:
            print(f"[dry-run] would start {p.describe()}")
        return

    managed: list[ManagedProc] = []
    periodic_integrity = args.integrity_sec > 0
    if periodic_integrity and args.skip_verify:
        print(
            "Note: initial verify was skipped; periodic integrity still runs "
            "(use --integrity-sec 0 to disable).",
            file=sys.stderr,
        )
    kproxy: KernelCallProxy | None = None
    proxy_kill_event: threading.Event | None = None
    proxy_kill_reason: list[str] | None = None
    cap_scope: dict[str, Any] = {}
    const_id = os.environ.get("ZAK_CONSTITUTION_ID", "zak-default")
    policy_hash_claim = ""
    adapter_oracles: dict[str, str] = {}
    try:
        if args.kernel_proxy_port > 0:
            policy = load_proxy_policy(data)
            adversarial = (
                os.environ.get("ZAK_ADVERSARIAL_MODE") == "1" or args.negative_proxy_test
            )
            resolver = ConstitutionResolver()
            try:
                resolved_const = resolver.resolve(const_id)
            except Exception as e:
                print(
                    f"[Engine] constitution resolution failed (fail-closed): {e}",
                    file=sys.stderr,
                )
                raise SystemExit(2) from e
            policy_hash_claim = resolved_const.policy_hash
            bundle_path = roots.adapters / "dist" / "index.js"
            if not bundle_path.is_file():
                print(
                    "[Engine] missing zak-adapters/dist/index.js — run build before proxied run",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            bundle_hash = sha256_file(bundle_path)
            expected_hashes = {
                n: bundle_hash
                for n in plugin_names
                if n in policy.untrusted_plugin_names
            }
            adapter_oracles = {n: f"pilot-{n}" for n in expected_hashes}
            proxy_kill_event = threading.Event()
            proxy_kill_reason = []

            def _on_proxy_kill(client_id: str, reason: str) -> None:
                proxy_kill_reason[:] = [
                    f"KernelCallProxy killed adapter subprocess "
                    f"(client_id={client_id!r}): {reason}"
                ]
                proxy_kill_event.set()
                print(
                    "[Engine] proxy_kill_event set — supervision wake (Kill → Shift)",
                    file=sys.stderr,
                )

            snap_path = _ENGINE_DIR / "capability_snapshot.json"
            snap_expected = os.environ.get("ZAK_CAPABILITY_SNAPSHOT_SHA256")
            try:
                cap_snapshot = load_capability_snapshot(
                    snap_path, expected_sha256=snap_expected or None
                )
            except Exception as e:
                print(
                    f"[Engine] capability snapshot load failed (fail-closed): {e}",
                    file=sys.stderr,
                )
                raise SystemExit(2) from e
            kproxy = KernelCallProxy(
                policy,
                resolver=resolver,
                gold_root=roots.gold,
                dependency_map_path=_ENGINE_DIR / "dependency_map.json",
                expected_bundle_hashes=expected_hashes,
                adapter_id_oracles=adapter_oracles,
                capability_snapshot=cap_snapshot,
                on_adapter_killed=_on_proxy_kill,
                adversarial_mode=adversarial,
            )
            kproxy.start_listener(args.kernel_proxy_host, args.kernel_proxy_port)
            cap_scope = (data.get("proxy") or {}).get("capability_scope") or {}
            print(
                json.dumps(
                    {
                        "gov": "proxy_started",
                        "client_id": None,
                        "adapter_id": None,
                        "host": args.kernel_proxy_host,
                        "port": args.kernel_proxy_port,
                        "constitution_id": const_id,
                        "policy_hash": policy_hash_claim,
                        "untrusted_plugins": sorted(policy.untrusted_plugin_names),
                        "adversarial_mode": adversarial,
                    },
                    sort_keys=True,
                ),
                file=sys.stderr,
            )
        for p in plugins:
            print(f"Starting adapter plugin: {p.describe()}")
            extra = dict(ctx.extra_env)
            if args.negative_proxy_test:
                extra["ZAK_NEGATIVE_EDGE_TEST"] = "1"
            if adversarial := (
                os.environ.get("ZAK_ADVERSARIAL_MODE") == "1" or args.negative_proxy_test
            ):
                extra["ZAK_ADVERSARIAL_MODE"] = "1"
            cid: str | None = None
            if (
                kproxy is not None
                and p.name in kproxy.untrusted_plugin_names
            ):
                cid = str(uuid.uuid4())
                caps_raw = cap_scope.get(p.name, [])
                caps_list = [str(x) for x in caps_raw] if isinstance(caps_raw, list) else []
                extra.update(
                    {
                        "ZAK_PROXY_CLIENT_ID": cid,
                        "ZAK_PROXY_HOST": args.kernel_proxy_host,
                        "ZAK_PROXY_PORT": str(args.kernel_proxy_port),
                        "ZAK_PROXY_PLUGIN": p.name,
                        "ZAK_ADAPTER_ID": f"pilot-{p.name}",
                        "ZAK_CONSTITUTION_ID": const_id,
                        "ZAK_POLICY_HASH_CLAIM": policy_hash_claim,
                        "ZAK_ADAPTER_CAPABILITIES": ",".join(caps_list),
                    }
                )
            child_ctx = replace(ctx, extra_env=extra)
            proc = p.start(child_ctx)
            if cid is not None and kproxy is not None:
                oracle = adapter_oracles.get(p.name, f"pilot-{p.name}")
                kproxy.register_client(cid, proc, p.name, oracle)
            managed.append(ManagedProc(proc=proc, plugin=p))
        if not managed:
            return
        print("Adapter processes running; Ctrl+C for Graceful Shift.", file=sys.stderr)
        _supervision_loop(
            gold,
            managed,
            heartbeat_sec=args.heartbeat_sec,
            integrity_sec=args.integrity_sec,
            health_timeout=args.health_timeout_sec,
            startup_grace_sec=args.startup_grace_sec,
            probe_http=not args.no_http_probe,
            periodic_integrity=periodic_integrity,
            proxy_kill_event=proxy_kill_event,
            proxy_kill_reason=proxy_kill_reason,
        )
    except KeyboardInterrupt:
        graceful_shift(managed, "Keyboard interrupt — stopping I/O adapters")
    finally:
        for m in managed:
            if m.proc.poll() is None:
                m.proc.send_signal(signal.SIGTERM)
        for m in managed:
            try:
                m.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                m.proc.kill()
        if kproxy is not None:
            kproxy.stop()


if __name__ == "__main__":
    main()
