"""What the Server screen is told about a newer Winglet: our own version compare, the release notes, who is busy.

The answer comes from the Winglet GitHub releases (plugin/hermes_api.latest_release), never from Hermes's own
update check, which cannot tell for a sub-directory install. Read-only: nothing here starts an update.
"""

import pytest

from plugin import hermes_api as api
from plugin import hub as hub_module
from test_control import FakeHermes, client, hub, settle, store  # noqa: F401  (fixtures)
from test_trust import pair_phone


# -- busy_bots: who would be interrupted by a restart ------------------------------------------------------------


def test_busy_means_working_or_anything_queued_and_nothing_private_is_listed():
    activity = {
        "zed": {"state": "idle", "queued": 0},
        "chef": {"state": "working", "queued": 2, "queue": [{"id": "x", "from": "Hermes", "preview": "secret plan"}]},
        "default": {"state": "idle", "queued": 3},
        "calm": {"state": "idle", "queued": None},
    }
    found = api.busy_bots(activity)
    assert found == {"bots": [{"bot": "chef", "state": "working", "queued": 2},
                              {"bot": "default", "state": "idle", "queued": 3}], "unknown": False}
    assert "secret" not in repr(found)


def test_unknown_activity_is_unknown_never_idle():
    assert api.busy_bots({"chef": {"state": "unknown", "queued": None}}) == {"bots": [], "unknown": True}
    assert api.busy_bots(None) == {"bots": [], "unknown": True}   # no way to look at all
    assert api.busy_bots({}) == {"bots": [], "unknown": False}    # looked, found no bots
    assert api.busy_bots({"chef": "nonsense", "x": None}) == {"bots": [], "unknown": True}
    mixed = api.busy_bots({"a": {"state": "working", "queued": 0}, "b": {"state": "unknown", "queued": None}})
    assert mixed == {"bots": [{"bot": "a", "state": "working", "queued": 0}], "unknown": True}


# -- GET /api/system/updates -------------------------------------------------------------------------------------


async def updates(client, owner, query=""):
    resp = await client.get("/api/system/updates" + query, headers=owner.auth)
    assert resp.status == 200
    return (await resp.json())["winglet"]


async def test_a_newer_release_is_offered_with_its_notes_and_never_asks_hermes_run_checks(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.23.0"
    winglet = await updates(client, owner)
    assert winglet["version"] == hub_module.VERSION
    assert winglet["update_available"] is True
    assert winglet["latest_release"] == hub.hermes.release
    assert winglet["requires_hermes_ok"] is True
    # FakeHermes.check_winglet_update raises if anything calls it: the answer did not come from Hermes's check.


@pytest.mark.parametrize("release_version,available", [(hub_module.VERSION, False), ("0.0.1", False), ("0.99.0", True)])
async def test_only_a_strictly_newer_release_is_an_update(client, hub, release_version, available):
    owner = await pair_phone(client, hub)
    hub.hermes.release = {**hub.hermes.release, "version": release_version, "tag": f"v{release_version}"}
    winglet = await updates(client, owner)
    assert winglet["update_available"] is available


async def test_no_stable_release_means_nothing_to_install(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.release = None
    winglet = await updates(client, owner)
    assert winglet["update_available"] is False and winglet["latest_release"] is None
    assert winglet["requires_hermes_ok"] is None   # nothing to be compatible with


async def test_an_unreachable_github_is_unknown_not_up_to_date(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.release = api.ReleaseCheckFailed("offline")
    data = await (await client.get("/api/system/updates", headers=owner.auth)).json()
    winglet = data["winglet"]
    assert winglet["update_available"] is None and winglet["latest_release"] is None
    assert winglet["requires_hermes_ok"] is None
    assert "check" in winglet["reason"].lower()
    assert data["hermes"]["behind"] == 3   # the Hermes half of the answer is not lost
    assert winglet["version"] == hub_module.VERSION


async def test_a_release_that_needs_a_newer_hermes_is_flagged_not_hidden(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.22.0"
    winglet = await updates(client, owner)
    assert winglet["update_available"] is True and winglet["requires_hermes_ok"] is False
    hub.hermes_version = lambda: ""
    hub._update_check = {}
    assert (await updates(client, owner))["requires_hermes_ok"] is None


async def test_the_release_lookup_is_remembered_but_busy_is_always_fresh(client, hub):
    owner = await pair_phone(client, hub)
    state = {"value": {"chef": {"state": "idle", "queued": 0}}}
    hub.activity_provider = lambda: state["value"]
    first = await updates(client, owner)
    assert first["busy"] == {"bots": [], "unknown": False}
    state["value"] = {"chef": {"state": "working", "queued": 1}}
    second = await updates(client, owner)
    assert second["busy"] == {"bots": [{"bot": "chef", "state": "working", "queued": 1}], "unknown": False}
    assert hub.hermes.release_calls == [False]           # one lookup for two requests
    await updates(client, owner, "?force=1")
    assert hub.hermes.release_calls == [False, True]     # force asks again


async def test_busy_is_unknown_when_nothing_can_look(client, hub):
    owner = await pair_phone(client, hub)
    assert hub.activity_provider is None
    assert (await updates(client, owner))["busy"] == {"bots": [], "unknown": True}


async def test_members_and_strangers_cannot_read_it(client, hub):
    await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await client.get("/api/system/updates", headers=member.auth)).status == 403
    assert (await client.get("/api/system/updates")).status in (401, 403)
