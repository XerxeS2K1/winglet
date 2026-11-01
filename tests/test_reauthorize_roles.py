"""Hermes 0.22.5+ re-checks role-authorized sources through the adapter's reauthorize_native_roles hook."""
import asyncio
import importlib.util

import pytest
from types import SimpleNamespace

pytestmark = pytest.mark.skipif(importlib.util.find_spec("gateway") is None, reason="needs Hermes Agent installed")

if importlib.util.find_spec("gateway") is not None:
    from plugin.adapter import USER_PREFIX, WingletAdapter


def adapter_with(devices):
    adapter = WingletAdapter.__new__(WingletAdapter)
    adapter._hub = SimpleNamespace(current_device=lambda ident: devices.get(ident))
    return adapter


def check(adapter, user_id):
    # Hermes looks the hook up on the class and passes the adapter in itself.
    return asyncio.run(type(adapter).reauthorize_native_roles(adapter, SimpleNamespace(user_id=user_id)))


def test_paired_device_is_allowed():
    assert check(adapter_with({"d1": {"role": "owner"}}), USER_PREFIX + "d1") is True


def test_unpaired_device_is_refused():
    assert check(adapter_with({}), USER_PREFIX + "gone") is False


def test_other_platform_ids_are_refused():
    assert check(adapter_with({"d1": {}}), "telegram:5") is False


def test_no_hub_is_refused():
    adapter = adapter_with({})
    adapter._hub = None
    assert check(adapter, USER_PREFIX + "d1") is False
