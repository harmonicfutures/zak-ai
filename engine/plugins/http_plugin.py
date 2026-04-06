"""HTTP ingress adapter plugin ( zak-adapters ``npm start``, ADAPTER_TYPE=http )."""

from __future__ import annotations

from .base import NpmAdapterPlugin


def create_http_plugin(port: str = "8080") -> NpmAdapterPlugin:
    return NpmAdapterPlugin(name="http", adapter_type="http", port=port)
