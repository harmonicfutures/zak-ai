"""Sentry / XDP hook plugin ( zak-adapters ``npm start``, ADAPTER_TYPE=sentry )."""

from __future__ import annotations

from .base import NpmAdapterPlugin


def create_sentry_plugin() -> NpmAdapterPlugin:
    return NpmAdapterPlugin(name="sentry", adapter_type="sentry", port=None)
