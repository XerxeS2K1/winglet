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
