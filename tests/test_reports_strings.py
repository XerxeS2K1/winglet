"""The routine-results feed is called Reports. An install that stored it as "Updates" must still show Reports."""

import pytest

from plugin.hub import HOME_CHAT_ID, Hub
from plugin.store import Store
from test_trust import pair_phone


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat(HOME_CHAT_ID, "Updates", kind="home")      # as an older install stored it
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.chat_goal = lambda chat_id: {"goal": "Watch it", "status": "active", "subgoals": []} if chat_id == HOME_CHAT_ID else None
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


def test_a_new_install_creates_the_feed_as_reports(tmp_path):
    fresh = Store(tmp_path / "fresh.db")
    h = Hub(fresh, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    chat = fresh.get_chat(HOME_CHAT_ID)
    assert (chat["title"], chat["kind"]) == ("Reports", "home")      # the id and kind do not change
    fresh.close()


async def test_the_feed_cannot_be_deleted_and_the_error_says_reports(client, hub):
    owner = await pair_phone(client, hub)
    response = await client.delete(f"/api/chats/{HOME_CHAT_ID}", headers=owner.auth)
    assert response.status == 400
    assert "Reports" in (await response.json())["error"] and "Updates" not in (await response.text())


async def test_a_push_for_the_feed_says_report_not_update(hub, monkeypatch):
    sent = []

    async def push_now(note, **kwargs):
        sent.append(note)
    monkeypatch.setattr(hub, "push_now", push_now)
    monkeypatch.setattr(hub, "_notifiable", lambda message: True)
    monkeypatch.setattr(hub, "schedule_push", lambda *a, **k: None)
    message = await hub.post_message(HOME_CHAT_ID, "The nightly backup finished.")
    await hub._delayed_push(HOME_CHAT_ID, message["id"], 0)
    assert [n["title"] for n in sent] == ["Hermes · Report"]


async def test_api_chats_shows_reports_while_db_still_says_updates(client, hub):
    owner = await pair_phone(client, hub)
    assert hub.store.get_chat(HOME_CHAT_ID)["title"] == "Updates"
    response = await client.get("/api/chats", headers=owner.auth)
    assert response.status == 200
    chats = (await response.json())["chats"]
    home = next(c for c in chats if c["id"] == HOME_CHAT_ID)
    assert home["title"] == "Reports"


async def test_an_old_stored_title_never_shows_in_the_export_name_goals_or_search(client, hub):
    owner = await pair_phone(client, hub)
    hub.store.add_message(HOME_CHAT_ID, "bot", "The backup finished.")
    export = await client.get(f"/api/chats/{HOME_CHAT_ID}/export", headers=owner.auth)
    assert export.status == 200
    assert "Reports" in export.headers["Content-Disposition"] and "Updates" not in export.headers["Content-Disposition"]
    goals = (await (await client.get("/api/goals", headers=owner.auth)).json())["goals"]
    assert [g["title"] for g in goals] == ["Reports"]
    found = (await (await client.get("/api/search?q=backup", headers=owner.auth)).json())["results"]
    assert [r["chat"]["title"] for r in found] == ["Reports"] and found[0]["chat"]["id"] == HOME_CHAT_ID
    assert hub.store.get_chat(HOME_CHAT_ID)["title"] == "Updates"    # displayed as Reports; stored data not migrated
