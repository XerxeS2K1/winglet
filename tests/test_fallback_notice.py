"""The 'model fell back' state the phone shows: whether it is on, why, and when Claude is retried."""

from types import SimpleNamespace

import pytest

from plugin import hermes_api

NOTICE = ("⚠️ Model fallback: claude-sonnet-5-5 via anthropic unavailable (rate limit); "
          "using reflection/beam-1.0-501b-a23b:free via nous. Primary retry eligible in ~105 s; "
          "recovery is not guaranteed.")


def agent(**kw):
    base = dict(model="reflection/beam-1.0-501b-a23b:free", provider="nous", _provider_fallback_active=True,
                _primary_runtime={"model": "claude-sonnet-5-5", "provider": "anthropic"}, _rate_limited_until=0)
    base.update(kw)
    return SimpleNamespace(**base)


def test_reason_is_read_from_hermes_notice():
    assert hermes_api.fallback_reason(NOTICE) == "rate limit"
    assert hermes_api.fallback_reason(NOTICE.replace("rate limit", "billing or quota exhausted")) == "billing or quota exhausted"
    assert hermes_api.fallback_reason(NOTICE.replace("rate limit", "authentication failed")) == "authentication failed"


@pytest.mark.parametrize("text", ["", "Context is 90% full", "⚠️ Model fallback changed shape", None])
def test_unrecognised_notice_gives_no_reason(text):
    assert hermes_api.fallback_reason(text) == ""


def test_not_on_a_fallback_means_no_state():
    assert hermes_api.fallback_state(agent(_provider_fallback_active=False)) is None
    assert hermes_api.fallback_state(SimpleNamespace(model="x")) is None


def test_cooldown_is_reported_as_seconds_left():
    state = hermes_api.fallback_state(agent(_rate_limited_until=1000.0 + 6911.2), now=1000.0)
    assert state == {"active": True, "reason": "", "retry_in_s": 6912,
                     "from_model": "claude-sonnet-5-5", "from_provider": "anthropic"}


def test_passed_cooldown_is_zero_not_negative():
    assert hermes_api.fallback_state(agent(_rate_limited_until=500.0), now=1000.0)["retry_in_s"] == 0


def test_no_cooldown_means_retry_on_next_message():
    assert hermes_api.fallback_state(agent(_rate_limited_until=0))["retry_in_s"] is None


def test_chat_model_carries_the_fallback():
    runner = SimpleNamespace(_cached_agent_for=lambda key: agent(_rate_limited_until=10**12))
    found = hermes_api.chat_model(runner, "chat")
    assert found["model"] == "reflection/beam-1.0-501b-a23b:free" and found["fallback"]["active"] is True
    primary = SimpleNamespace(_cached_agent_for=lambda key: agent(_provider_fallback_active=False))
    assert "fallback" not in hermes_api.chat_model(primary, "chat")


def adapter_cls():
    pytest.importorskip("gateway.session_context")  # needs Hermes's gateway package
    from plugin.adapter import WingletAdapter
    return WingletAdapter


def fake_adapter(cls, ag):
    me = SimpleNamespace(_fallback_reasons={}, name="winglet", _session_key=lambda chat: "key:" + chat,
                         gateway_runner=SimpleNamespace(_cached_agent_for=lambda key: ag))
    return me


def test_adapter_adds_the_reason_it_saw_in_the_notice():
    cls = adapter_cls()
    me = fake_adapter(cls, agent(_rate_limited_until=10**12))
    me._fallback_reasons["chat-1"] = "rate limit"
    assert cls._chat_model(me, "chat-1")["fallback"]["reason"] == "rate limit"
    assert cls._chat_model(me, "chat-2")["fallback"]["reason"] == ""  # no notice seen for this chat


def test_adapter_forgets_the_reason_once_back_on_the_primary():
    cls = adapter_cls()
    me = fake_adapter(cls, agent(_provider_fallback_active=False))
    me._fallback_reasons["chat-1"] = "rate limit"
    assert "fallback" not in cls._chat_model(me, "chat-1")
    assert me._fallback_reasons == {}
