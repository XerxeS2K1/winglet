"""Review findings #16 and #17: a Hermes that changed shape turns a feature off; it does not crash the route."""
import sys
import types

import pytest

from plugin import hermes_api


def fake_pause_module(monkeypatch, **functions):
    """An `agent` package whose pause module has only the given functions."""
    agent = types.ModuleType("agent")
    agent.__path__ = []
    module = types.ModuleType("agent.estop")
    for name, value in functions.items():
        setattr(module, name, value)
    agent.estop = module
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.estop", module)


# -- #16 ---------------------------------------------------------------------------------------------------------------

def test_pausing_without_the_hermes_pause_module_is_unavailable_not_a_crash(monkeypatch):
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.estop", None)           # the import fails
    with pytest.raises(hermes_api.HermesUnavailable):
        hermes_api.set_paused(True, "x")
    with pytest.raises(hermes_api.HermesUnavailable):
        hermes_api.set_paused(False)


def test_pausing_with_a_renamed_function_is_unavailable(monkeypatch):
    fake_pause_module(monkeypatch, engage=lambda reason: None, get_state=lambda: None)   # `disengage` is gone
    with pytest.raises(hermes_api.HermesUnavailable):
        hermes_api.set_paused(False)


def test_pausing_still_works_when_hermes_has_the_switch(monkeypatch):
    calls = []
    fake_pause_module(monkeypatch, engage=lambda reason: calls.append(("on", reason)),
                      disengage=lambda: calls.append(("off",)), get_state=lambda: {"reason": "r"})
    assert hermes_api.set_paused(True, "why") == {"reason": "r"}
    assert hermes_api.set_paused(True) == {"reason": "r"}
    assert hermes_api.set_paused(False) == {"reason": "r"}
    assert calls == [("on", "why"), ("on", "paused from Winglet"), ("off",)]


# -- #17 ---------------------------------------------------------------------------------------------------------------

def sessions_router(monkeypatch, **overrides):
    """A fake Hermes sessions router whose functions take what this Hermes's real ones take."""
    def get_sessions(limit=20, offset=0, min_messages=0, archived="exclude", order="created", source=None, sources=None,
                     exclude_sources=None, cwd_prefix=None, full=False, profile=None): ...

    async def search_sessions(q="", limit=20, profile=None, source=None, sources=None, exclude_sources=None): ...

    async def get_session_detail(session_id, profile=None): ...

    async def get_session_messages(session_id, profile=None, limit=None, offset=0, order=None, include_compacted=False,
                                   inline_images=True): ...

    router = types.SimpleNamespace(get_sessions=get_sessions, search_sessions=search_sessions,
                                   get_session_detail=get_session_detail, get_session_messages=get_session_messages)
    for name, fn in overrides.items():
        setattr(router, name, fn)
    monkeypatch.setattr(hermes_api, "_router", lambda name: router)


def test_sessions_are_available_when_hermes_takes_every_keyword_we_pass(monkeypatch):
    sessions_router(monkeypatch)
    assert hermes_api.sessions_available() is True


@pytest.mark.parametrize("name,fn", [
    ("get_sessions", lambda limit=20, offset=0, min_messages=0, archived="exclude", order="created", source=None,
     sources=None, exclude_sources=None, cwd_prefix=None, full=False, profile_name=None: None),   # `profile` renamed
    ("search_sessions", lambda query="", limit=20, profile=None, source=None, sources=None, exclude_sources=None: None),
    ("get_session_messages", lambda session_id, profile=None, limit=None, offset=0, order=None: None),  # kwargs dropped
    ("get_session_detail", "not callable"),
])
def test_sessions_turn_themselves_off_when_a_keyword_was_renamed(monkeypatch, name, fn):
    sessions_router(monkeypatch, **{name: fn})
    assert hermes_api.sessions_available() is False


def test_a_router_that_takes_any_keyword_is_trusted(monkeypatch):
    sessions_router(monkeypatch, get_sessions=lambda **kw: None)
    assert hermes_api.sessions_available() is True
