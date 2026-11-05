"""A new chat takes the name Hermes gives its session, and never overwrites a name a person chose."""

import asyncio
from types import SimpleNamespace

import pytest

from test_adapter_media import adapter  # noqa: F401  (fixture)


def new_chat(hub, title=""):
    return hub.store.create_chat(title)["id"]


def title_of(hub, chat_id):
    return hub.store.get_chat(chat_id)["title"]


async def test_an_unnamed_chat_takes_hermes_title_and_tells_the_phone(adapter, monkeypatch):
    hub = adapter._hub
    sent = []

    async def broadcast(event, scope=None):
        sent.append(event)

    monkeypatch.setattr(hub, "_broadcast", broadcast)
    chat = new_chat(hub)
    assert title_of(hub, chat) == "New chat"
    assert await hub.auto_title_chat(chat, "Ask bot multiplication question") is True
    assert title_of(hub, chat) == "Ask bot multiplication question"
    # The phone hears about it, so the sidebar and header change without a refresh.
    assert [(e["type"], e["chat"]["title"]) for e in sent] == [("chat.update", "Ask bot multiplication question")]


async def test_a_name_somebody_typed_is_never_replaced(adapter):
    hub = adapter._hub
    chat = new_chat(hub, "My trip to Rome")
    assert hub.can_auto_title(chat) is False
    assert await hub.auto_title_chat(chat, "Plan a holiday") is False
    assert title_of(hub, chat) == "My trip to Rome"


async def test_renaming_after_an_automatic_name_stops_further_changes(adapter):
    hub = adapter._hub
    chat = new_chat(hub)
    await hub.auto_title_chat(chat, "Quick draft title")
    hub.store.rename_chat(chat, "Mine")  # the person renames it
    assert hub.can_auto_title(chat) is False
    assert await hub.auto_title_chat(chat, "Better model title") is False
    assert title_of(hub, chat) == "Mine"


async def test_the_better_title_replaces_the_quick_one(adapter):
    hub = adapter._hub
    chat = new_chat(hub)
    await hub.auto_title_chat(chat, "can you check the")
    assert await hub.auto_title_chat(chat, "Check the server logs") is True
    assert title_of(hub, chat) == "Check the server logs"
    # Same title again changes nothing.
    assert await hub.auto_title_chat(chat, "Check the server logs") is False


async def test_the_updates_chat_and_empty_titles_are_left_alone(adapter):
    hub = adapter._hub
    hub.store.ensure_chat("home-test", "New chat", kind="home")
    assert await hub.auto_title_chat("home-test", "Something") is False
    chat = new_chat(hub)
    assert await hub.auto_title_chat(chat, "   ") is False
    assert title_of(hub, chat) == "New chat"
    assert await hub.auto_title_chat("c-missing", "Hello") is False


async def test_a_long_title_is_cut_to_the_chat_name_limit(adapter):
    hub = adapter._hub
    chat = new_chat(hub)
    await hub.auto_title_chat(chat, "word " * 60)
    assert len(title_of(hub, chat)) <= 80


async def test_the_adapter_follows_hermes_as_the_title_improves(adapter, monkeypatch):
    """Hermes writes a quick title first and the model's title a few seconds later; both reach the chat."""
    hub = adapter._hub
    chat = new_chat(hub)
    steps = iter([(None, None), ("can you check the", "derived"), ("can you check the", "derived"),
                  ("Check the server logs", "llm"), ("SHOULD NOT BE READ", "llm")])
    seen = []

    def hermes_title(chat_id):
        seen.append(chat_id)
        return next(steps)

    adapter._hermes_title = hermes_title
    adapter._running = True
    await adapter._follow_hermes_title(chat, wait=0, patience=5)
    assert title_of(hub, chat) == "Check the server logs"
    assert len(seen) == 4  # it stopped at the model's title


async def test_the_adapter_stops_when_the_person_names_the_chat(adapter):
    hub = adapter._hub
    chat = new_chat(hub, "Mine")
    adapter._hermes_title = lambda chat_id: pytest.fail("should not even look")
    adapter._running = True
    await adapter._follow_hermes_title(chat, wait=0, patience=5)
    assert title_of(hub, chat) == "Mine"


async def test_starting_a_turn_follows_the_title_only_once_per_chat(adapter):
    hub = adapter._hub
    chat = new_chat(hub)
    adapter._loop = asyncio.get_running_loop()
    adapter._running = True
    adapter._title_followers = {}
    calls = []

    async def follow(chat_id, **kw):
        calls.append(chat_id)
        await asyncio.sleep(0.05)

    adapter._follow_hermes_title = follow
    event = SimpleNamespace(source=SimpleNamespace(chat_id=chat))
    await adapter.on_processing_start(event)
    await adapter.on_processing_start(event)
    await asyncio.sleep(0.1)
    assert calls == [chat]
    assert adapter._title_followers == {}


async def test_reading_hermes_title_goes_through_its_session_store(adapter):
    class Db:
        def get_session_title(self, sid):
            return {"s1": "Rate limits on Claude"}.get(sid)

        def get_session_title_source(self, sid):
            return "llm"

    class Store:
        def peek_session_id(self, key):
            return {"the-key": "s1"}.get(key)

        def _db_for_session_id(self, sid):
            return Db()

    adapter.gateway_runner = SimpleNamespace(session_store=Store())
    adapter._session_key = lambda chat_id: "the-key"
    assert adapter._hermes_title("c-x") == ("Rate limits on Claude", "llm")
    adapter._session_key = lambda chat_id: "other-key"
    assert adapter._hermes_title("c-x") == (None, None)
    adapter.gateway_runner = SimpleNamespace(session_store=None)
    assert adapter._hermes_title("c-x") == (None, None)


def test_hermes_session_database_offers_the_title_calls_we_read(tmp_path):
    """The real Hermes class, not a stand-in: the two calls the adapter makes exist and mean what we assume."""
    hermes_state = pytest.importorskip("hermes_state")
    db = hermes_state.SessionDB(tmp_path / "state.db")
    db.create_session("s1", source="winglet")
    assert db.get_session_title("s1") is None
    assert db.get_session_title_source("s1") is None
    assert db.set_auto_title("s1", "can you check the", source="derived")
    assert (db.get_session_title("s1"), db.get_session_title_source("s1")) == ("can you check the", "derived")
    assert db.set_auto_title("s1", "Check the server logs", source="llm")
    assert (db.get_session_title("s1"), db.get_session_title_source("s1")) == ("Check the server logs", "llm")
