"""Branching against a real Hermes that has the newer storage interface (``persistence``).

Hermes 0.23 removed the session database the bridge used to call, so these run the real bridge over the
real Hermes session store: snapshot, seed a branch, route it, rewind in place. Skipped on older Hermes,
which test_branching.py covers.
"""

from __future__ import annotations

import importlib.util

import pytest

needs_new_hermes = pytest.mark.skipif(
    importlib.util.find_spec("persistence_assembly") is None or importlib.util.find_spec("gateway") is None,
    reason="needs a Hermes Agent with the storage interface")


def _store(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from persistence.conversation.messages import NewMessage
    from persistence.conversation.sessions import NewSession

    store = SessionStore(sessions_dir=tmp_path / "sessions", config=GatewayConfig())
    p = store.persistence
    p.sessions.create(NewSession(session_id="parent", source="telegram"))
    for role, text, pm in [("user", "one", "u1"), ("assistant", "first", None),
                           ("user", "two", "u2"), ("assistant", "second", None)]:
        p.messages.append("parent", NewMessage(role=role, content=text, platform_message_id=pm))
    store.peek_session_id = lambda key: "parent" if key == "agent:main:telegram:dm:parent" else None
    return store


def _adapter(store):
    from gateway.platforms.base import Platform, SessionSource
    from gateway.session import AsyncSessionStore

    class Runner:
        session_store = store
        async_session_store = AsyncSessionStore(store)

        def _evict_cached_agent(self, key):
            pass

    class Adapter:
        gateway_runner = Runner()

        def build_source(self, **kw):
            return SessionSource(platform=Platform.TELEGRAM, chat_id=kw["chat_id"], chat_type="dm",
                                 user_id=kw["user_id"])

        def _session_key(self, chat_id):
            return f"agent:main:telegram:dm:{chat_id}"

        def _chat_model(self, chat_id):
            return None

    return Adapter()


@needs_new_hermes
async def test_bridge_snapshots_seeds_routes_and_rewinds_on_the_storage_interface(tmp_path, monkeypatch):
    from plugin.branching import HermesBranchBridge

    store = _store(tmp_path, monkeypatch)
    adapter = _adapter(store)
    bridge = HermesBranchBridge(adapter)
    assert bridge.available() is True
    snap = await bridge.snapshot("parent")
    assert [r["content"] for r in snap.rows] == ["one", "first", "two", "second"]

    sid = await bridge.create_branch_session(
        {"id": "child", "title": "Child", "bot": None}, {"id": "dev", "name": "Phone"}, "Child",
        snap, [{**snap.rows[0], "message_id": "copied-u1"}, snap.rows[1]])
    copied = store.load_transcript(sid)
    assert [r["content"] for r in copied] == ["one", "first"]
    assert copied[0]["message_id"] == "copied-u1"
    assert store._entries["agent:main:telegram:dm:child"].session_id == sid
    assert store.persistence.sessions.get(sid).parent_session_id == "parent"
    assert [r["content"] for r in store.load_transcript("parent")] == ["one", "first", "two", "second"]

    result = await bridge.rewind_latest("parent", "two", adapter.build_source(chat_id="parent", user_id="u"))
    assert result["target_text"] == "two" and result["turns_undone"] == 1
    assert [r["content"] for r in store.load_transcript("parent")] == ["one", "first"]
