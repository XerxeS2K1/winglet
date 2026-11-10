"""Goals, message search and the files in a chat."""

import sys
import time
from types import ModuleType

import pytest

from plugin import hermes_api
from plugin.hub import Hub, _snippet
from plugin.store import Store
from test_trust import pair_phone


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    store.ensure_chat("trip", "Trip to Lisbon")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    goals = {"trip": {"goal": "Book the whole trip", "status": "active", "turns_used": 3, "max_turns": 20,
                      "subgoals": ["Hotel under 150/night"], "last_verdict": "continue", "last_reason": "Flights found",
                      "paused_reason": None, "waiting_reason": None, "created_at": 1.0, "last_turn_at": 5.0}}
    h.chat_goal = goals.get
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def test_a_chat_shows_its_goal(client, hub):
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/chats/trip/goal", headers=owner.auth)).json()
    assert data["goal"]["goal"] == "Book the whole trip" and data["goal"]["subgoals"] == ["Hotel under 150/night"]
    assert (await (await client.get("/api/chats/general/goal", headers=owner.auth)).json())["goal"] is None
    listed = await (await client.get("/api/goals", headers=owner.auth)).json()
    assert [(g["chat_id"], g["title"]) for g in listed["goals"]] == [("trip", "Trip to Lisbon")]


async def test_members_only_see_goals_in_their_own_chats(client, hub):
    await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await client.get("/api/chats/trip/goal", headers=member.auth)).status == 404
    assert (await (await client.get("/api/goals", headers=member.auth)).json())["goals"] == []


async def test_a_broken_goal_lookup_reads_as_no_goal(client, hub):
    owner = await pair_phone(client, hub)

    def broken(chat_id):
        raise RuntimeError("session db locked")
    hub.chat_goal = broken
    assert (await (await client.get("/api/chats/trip/goal", headers=owner.auth)).json())["goal"] is None
    assert (await (await client.get("/api/goals", headers=owner.auth)).json())["goals"] == []


async def test_search_finds_words_in_chats_you_can_see(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    hub.store.add_message("trip", "bot", "The cheapest flight to Lisbon leaves at 7:40 on Friday.")
    hub.store.add_message("general", "user", "remind me about lisbon")
    hub.store.add_message("general", "system", "Lisbon status line")
    hub.store.add_message("general", "user", "lisbon secret helper", meta={"hidden": True})
    mine = hub.store.ensure_chat("m-" + member.id, "Alex", owner_device=member.id)
    hub.store.add_message(mine["id"], "user", "Is Lisbon nice in May?")

    results = (await (await client.get("/api/search?q=LISBON", headers=owner.auth)).json())["results"]
    assert [r["chat"]["id"] for r in results] == [mine["id"], "general", "trip"]
    assert results[-1]["snippet"].startswith("The cheapest flight to Lisbon")
    assert results[-1]["message"]["position"] > 0

    theirs = (await (await client.get("/api/search?q=lisbon", headers=member.auth)).json())["results"]
    assert [r["chat"]["id"] for r in theirs] == [mine["id"]]
    assert (await (await client.get("/api/search?q=l", headers=owner.auth)).json())["results"] == []


async def test_search_treats_wildcards_as_text(client, hub):
    owner = await pair_phone(client, hub)
    hub.store.add_message("general", "bot", "Disk is 95% full")
    hub.store.add_message("general", "bot", "Disk is 95 full")
    results = (await (await client.get("/api/search?q=95%25", headers=owner.auth)).json())["results"]
    assert len(results) == 1


async def test_search_matches_every_word_across_line_breaks(client, hub):
    owner = await pair_phone(client, hub)
    hub.store.add_message("trip", "bot", "Found a place in Lisbon\nhotel Avenida, 140 a night")
    hub.store.add_message("trip", "bot", "Lisbon is sunny")
    for q in ("lisbon hotel", "hotel  lisbon"):
        results = (await (await client.get("/api/search", params={"q": q}, headers=owner.auth)).json())["results"]
        assert len(results) == 1 and "Lisbon hotel Avenida" in results[0]["snippet"]


def test_snippets_center_on_the_match():
    text = "word " * 40 + "the needle is here " + "tail " * 40
    snip = _snippet(text, "needle")
    assert "needle" in snip and snip.startswith("…") and snip.endswith("…")
    assert not snip[1:].startswith(" ")
    assert _snippet("short needle", "needle") == "short needle"
    # Words that aren't next to each other: centered on the earliest one.
    spread = "word " * 40 + "the hotel " + "word " * 40 + "in lisbon"
    assert "the hotel" in _snippet(spread, "lisbon hotel")


def test_goals_are_only_offered_when_hermes_has_them(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli", ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.goals", None)
    assert hermes_api.goals_available() is False
    monkeypatch.setitem(sys.modules, "hermes_cli.goals", ModuleType("hermes_cli.goals"))
    assert hermes_api.goals_available() is True


async def test_files_lists_everything_shared_newest_first(client, hub):
    owner = await pair_phone(client, hub)
    photo = {"id": "u1", "name": "beach.jpg", "mime": "image/jpeg", "kind": "image", "size": 10, "url": "/api/media/u1/beach.jpg?sig=x"}
    doc = {"id": "u2", "name": "plan.pdf", "mime": "application/pdf", "kind": "file", "size": 20, "url": "/api/media/u2/plan.pdf?sig=y"}
    hub.store.add_message("trip", "user", "here", meta={"attachments": [photo]})
    hub.store.add_message("trip", "bot", "no files here")
    hub.store.add_message("trip", "bot", "the plan", meta={"attachments": [doc]})
    files = (await (await client.get("/api/chats/trip/files", headers=owner.auth)).json())["files"]
    assert [(f["name"], f["role"]) for f in files] == [("plan.pdf", "bot"), ("beach.jpg", "user")]
    assert files[0]["message_id"]
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await client.get("/api/chats/trip/files", headers=member.auth)).status == 404


async def test_search_is_capped_paged_and_runs_off_the_event_loop(client, hub, monkeypatch):
    import threading
    owner = await pair_phone(client, hub)
    for i in range(8):
        hub.store.add_message("general", "user", f"needle {i}")
    found, next_before = hub.store.search_page("needle", ["general"], limit=2, scan_limit=3)
    assert len(found) == 2 and next_before is not None
    older, _ = hub.store.search_page("needle", ["general"], limit=2, before_position=next_before, scan_limit=3)
    assert {m["id"] for m in older}.isdisjoint({m["id"] for m in found})

    calls = []
    real = hub.store.search_page

    def tracked(*args, **kwargs):
        calls.append(threading.get_ident())
        return real(*args, **kwargs)

    monkeypatch.setattr(hub.store, "search_page", tracked)
    data = await (await client.get("/api/search?q=needle", headers=owner.auth)).json()
    assert len(data["results"]) <= 60
    assert "next_before" in data
    assert calls and calls[0] != threading.get_ident()


def test_search_finds_a_match_older_than_the_old_row_window(store):
    store.ensure_chat("general", "General")
    now = time.time()
    with store._db:
        store._db.executemany(
            "INSERT INTO messages (id, chat_id, role, text, status, meta, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [("old-needle", "general", "user", "the needle is old", "final", "{}", now, now)]
            + [(f"noise-{i}", "general", "user", f"noise {i}", "final", "{}", now, now)
               for i in range(5001)])
    found, next_before = store.search_page("needle", ["general"], limit=60, scan_limit=50)
    assert [m["id"] for m in found] == ["old-needle"]
    assert next_before is None
