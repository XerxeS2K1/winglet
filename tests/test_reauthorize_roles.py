"""Hermes 0.22.5+ re-checks role-authorized sources through the adapter's reauthorize_native_roles hook."""
import asyncio
import importlib.util

import pytest
from types import SimpleNamespace

pytestmark = pytest.mark.skipif(importlib.util.find_spec("gateway") is None, reason="needs Hermes Agent installed")

if importlib.util.find_spec("gateway") is not None:
    from plugin.adapter import USER_PREFIX, WingletAdapter


def adapter_with(devices, calls=None):
    def current_device(ident, **kwargs):
        # Hub.current_device takes fresh=; the fake takes the same shape so a change to how the hook
        # asks for a device is caught here rather than swallowed by the refusal path.
        if calls is not None:
            calls.append((ident, kwargs))
        return devices.get(ident)

    adapter = WingletAdapter.__new__(WingletAdapter)
    adapter._hub = SimpleNamespace(current_device=current_device)
    return adapter


def check(adapter, user_id):
    # Hermes looks the hook up on the class and passes the adapter in itself.
    return asyncio.run(type(adapter).reauthorize_native_roles(adapter, SimpleNamespace(user_id=user_id)))


def test_paired_device_is_allowed():
    calls = []
    assert check(adapter_with({"d1": {"role": "owner"}}, calls), USER_PREFIX + "d1") is True
    # Deciding a turn must not read a cached pairing row: a device unpaired a moment ago has to be refused.
    assert calls == [("d1", {"fresh": True})]


def test_unpaired_device_is_refused():
    assert check(adapter_with({}), USER_PREFIX + "gone") is False


def test_other_platform_ids_are_refused():
    calls = []
    assert check(adapter_with({"d1": {}}, calls), "telegram:5") is False
    assert calls == []


def test_no_hub_is_refused():
    adapter = adapter_with({})
    adapter._hub = None
    assert check(adapter, USER_PREFIX + "d1") is False
