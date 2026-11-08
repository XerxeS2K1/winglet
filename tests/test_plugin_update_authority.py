"""Reviewer-found TOCTOU: owner authority must be rechecked after awaited release lookup."""
import asyncio
import threading

import pytest

from plugin.hub import VERSION
from test_control import client, hub, settle, store  # noqa: F401
from test_plugin_update_flow import NEXT, owner, update


@pytest.mark.parametrize("change", ["demote", "delete", "revoke_key"])
async def test_authority_change_during_release_lookup_refuses_before_a_job(client, hub, owner, change):
    hub.store.add_device("Remaining owner", "test", role="owner")
    entered, resume = threading.Event(), threading.Event()
    original = hub.hermes.latest_release

    def held(force=False):
        entered.set()
        assert resume.wait(5)
        return original(force)

    hub.hermes.latest_release = held
    task = asyncio.create_task(update(client, owner, version=NEXT))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        if change == "demote":
            hub.store.update_device(owner.id, role="member")
        elif change == "delete":
            hub.store.remove_device(owner.id)
        else:
            hub.store.set_device_key(owner.id, "new-key")
    finally:
        resume.set()
    response = await task
    await settle(hub)
    assert response.status == 403
    assert hub.store.list_jobs() == []
    assert [c for c in hub.hermes.calls if c[0] != "settle"] == []
    assert hub.hermes.restarts == 0
    assert "no longer has owner authority" in (await response.json())["error"]
