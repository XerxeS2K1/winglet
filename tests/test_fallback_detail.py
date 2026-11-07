"""Explicit Hermes fallback evidence survives cache eviction, but never leaks across a session or /model change."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytest.importorskip('gateway.session_context')  # needs Hermes's gateway package

from plugin import hermes_api
from plugin.adapter import WingletAdapter

PRE = ("⚠️ Provider fallback: anthropic/claude-sonnet-5-5 unavailable; "
       "using openai-codex/gpt-6.1-sol for this response.")
MID = ("⚠️ Model fallback: claude-sonnet-5-5 via anthropic unavailable (rate limit); "
       "using gpt-6.1-sol via openai-codex. Primary retry eligible in ~120 s; recovery is not guaranteed.")


def live(model="gpt-6.1-sol", provider="openai-codex", fallback=False):
    return SimpleNamespace(model=model, provider=provider, _provider_fallback_active=fallback,
                           _primary_runtime={"model": "claude-sonnet-5-5", "provider": "anthropic"},
                           _rate_limited_until=1120.0)


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setattr(hermes_api.time, "monotonic", lambda: 1000.0)
    cached = {}
    ids = {"key:one": "session-one", "key:two": "session-two"}
    runner = SimpleNamespace(_cached_agent_for=cached.get, _session_model_overrides={},
                             _last_resolved_model={}, session_store=SimpleNamespace(peek_session_id=ids.get))
    adapter = WingletAdapter.__new__(WingletAdapter)
    adapter.gateway_runner = runner
    adapter._fallback_reasons = {}
    adapter._fallback_history = None
    adapter._status_ids = {}
    adapter._bot_of = lambda chat: None
    adapter._bot_adapter = lambda bot: None
    adapter._session_key = lambda chat: "key:" + chat
    adapter._hub = SimpleNamespace(store=SimpleNamespace(get_message=lambda _: None),
                                   post_message=AsyncMock(return_value={"id": "status"}))
    return adapter, runner, cached, ids


@pytest.mark.asyncio
async def test_pre_agent_notice_supplies_explicit_routes_without_invented_reason_or_cooldown(setup):
    a, runner, cached, _ = setup
    cached["key:one"] = live()
    await a.send_or_update_status("one", "lifecycle", PRE)
    result = a._chat_model("one")
    assert result["model"] == "gpt-6.1-sol"
    assert result["provider"] == "openai-codex"
    assert result["fallback"] == {"active": True, "reason": "provider unavailable", "retry_in_s": None,
                                  "from_model": "claude-sonnet-5-5", "from_provider": "anthropic"}
    cached.clear()
    runner._last_resolved_model["key:one"] = "gpt-6.1-sol"
    assert a._chat_model("one") == result


@pytest.mark.asyncio
async def test_successful_in_turn_eviction_keeps_model_reason_and_decreasing_deadline(setup, monkeypatch):
    a, runner, cached, _ = setup
    cached["key:one"] = live(fallback=True)
    await a.send_or_update_status("one", "lifecycle", MID)
    before = a._chat_model("one")
    assert before["fallback"]["reason"] == "rate limit"
    assert before["fallback"]["retry_in_s"] == 120
    # Hermes records resolution before the in-turn fallback, then deliberately evicts its agent after success.
    runner._last_resolved_model["key:one"] = "claude-sonnet-5-5"
    cached.clear()
    monkeypatch.setattr(hermes_api.time, "monotonic", lambda: 1015.1)
    result = a._chat_model("one")
    assert result["model"] == "gpt-6.1-sol"
    assert result["fallback"]["retry_in_s"] == 105
    assert result["fallback"]["reason"] == "rate limit"
    monkeypatch.setattr(hermes_api.time, "monotonic", lambda: 1200.0)
    assert a._chat_model("one")["fallback"]["retry_in_s"] == 0


@pytest.mark.asyncio
async def test_live_primary_recovery_clears_record_and_does_not_reappear_after_eviction(setup):
    a, runner, cached, _ = setup
    await a.send_or_update_status("one", "lifecycle", MID)
    cached["key:one"] = live("claude-sonnet-5-5", "anthropic")
    assert "fallback" not in a._chat_model("one")
    cached.clear()
    runner._last_resolved_model["key:one"] = "claude-sonnet-5-5"
    assert "fallback" not in a._chat_model("one")


@pytest.mark.asyncio
async def test_intentional_model_switch_to_the_same_secondary_is_not_fallback(setup):
    a, runner, cached, _ = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    runner._session_model_overrides["key:one"] = {"model": "gpt-6.1-sol", "provider": "openai-codex"}
    cached["key:one"] = live()
    assert "fallback" not in a._chat_model("one")
    cached.clear()
    assert a._chat_model("one")["source"] == "chat"
    assert "fallback" not in a._chat_model("one")


@pytest.mark.asyncio
async def test_preexisting_override_is_not_mistaken_for_a_new_model_switch(setup):
    a, runner, cached, _ = setup
    runner._session_model_overrides["key:one"] = {"model": "claude-sonnet-5-5", "provider": "anthropic"}
    await a.send_or_update_status("one", "lifecycle", PRE)
    assert a._chat_model("one")["model"] == "gpt-6.1-sol"
    assert a._chat_model("one")["fallback"]["active"] is True


@pytest.mark.asyncio
async def test_new_session_clears_old_evidence_even_when_chat_id_is_reused(setup):
    a, _, _, ids = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    ids["key:one"] = "new-session"
    assert a._chat_model("one") is None


@pytest.mark.asyncio
async def test_missing_cache_and_last_model_do_not_erase_explicit_evidence(setup):
    a, _, _, _ = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    assert a._chat_model("one")["fallback"]["active"] is True
    assert a._chat_model("two") is None


@pytest.mark.asyncio
async def test_other_profile_same_chat_id_cannot_borrow_fallback(setup):
    a, runner, _, _ = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    other = WingletAdapter.__new__(WingletAdapter)
    other.__dict__.update(a.__dict__)
    other._fallback_history = None
    other._fallback_reasons = {}
    other._session_key = lambda chat: "other:" + chat
    runner._last_resolved_model["other:one"] = "gpt-6.1-sol"
    assert "fallback" not in other._chat_model("one")
    # The hub's primary adapter consults the owning secondary adapter's history, not its own.
    a._bot_of = lambda chat: "other"
    a._bot_adapter = lambda bot: other
    a._session_key = other._session_key
    assert "fallback" not in a._chat_model("one")
    await other.send_or_update_status("one", "lifecycle", PRE)
    assert a._chat_model("one")["fallback"]["active"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["Context is 90% full", "Model fallback changed shape", "", "gpt-6.1-sol"])
async def test_mismatched_model_or_unrecognised_status_never_creates_fallback(setup, text):
    a, runner, _, _ = setup
    await a.send_or_update_status("one", "lifecycle", text)
    runner._last_resolved_model["key:one"] = text or "another-model"
    assert "fallback" not in a._chat_model("one")


@pytest.mark.asyncio
async def test_returned_state_is_a_copy_not_mutable_history(setup):
    a, _, _, _ = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    result = a._chat_model("one")
    result["fallback"]["from_model"] = "corrupted"
    assert a._chat_model("one")["fallback"]["from_model"] == "claude-sonnet-5-5"


@pytest.mark.asyncio
async def test_new_session_does_not_reuse_old_reason_for_a_new_flag_only_fallback(setup):
    a, _, cached, ids = setup
    await a.send_or_update_status("one", "lifecycle", MID)
    assert a._chat_model("one")["fallback"]["reason"] == "rate limit"
    ids["key:one"] = "fresh-session"
    cached["key:one"] = live(fallback=True)
    # This session has an explicit active flag, but no reason notice yet. The old session's reason is not evidence.
    assert a._chat_model("one")["fallback"]["reason"] == ""
    assert a._chat_model("one")["fallback"]["reason"] == ""


@pytest.mark.asyncio
async def test_no_http_poll_is_needed_before_success_evicts_agent(setup):
    a, runner, cached, _ = setup
    cached["key:one"] = live(fallback=True)
    await a.send_or_update_status("one", "lifecycle", MID)
    cached.clear()  # no _chat_model call while the agent was resident
    runner._last_resolved_model["key:one"] = "claude-sonnet-5-5"
    assert a._chat_model("one")["fallback"]["reason"] == "rate limit"
    assert a._chat_model("one")["model"] == "gpt-6.1-sol"


def test_explicit_live_flag_can_be_snapshotted_without_notice(setup):
    a, _, cached, _ = setup
    cached["key:one"] = live(fallback=True)
    assert a._chat_model("one")["fallback"]["active"]
    cached.clear()
    assert a._chat_model("one")["fallback"]["active"]


@pytest.mark.asyncio
async def test_fresh_adapter_does_not_replay_old_notice(setup):
    a, runner, _, _ = setup
    await a.send_or_update_status("one", "lifecycle", PRE)
    a._fallback_history = None
    a._fallback_reasons.clear()
    runner._last_resolved_model["key:one"] = "gpt-6.1-sol"
    assert "fallback" not in a._chat_model("one")


@pytest.mark.parametrize("kind", ["provider", "model"])
def test_known_notice_formats_preserve_slashes_and_dots_in_model_names(kind):
    from plugin.fallback import parse_notice
    if kind == "provider":
        from hermes_cli.fallback_config import pre_agent_fallback_notice
        # The real Hermes formatter, without credentials, providers or a running gateway.
        text = pre_agent_fallback_notice("anthropic", "claude-5.5", "openrouter", "vendor/model-1.2:free")
    else:
        text = "⚠️ Model fallback: claude-5.5 via anthropic unavailable (billing or quota exhausted); using vendor/model-1.2:free via openrouter."
    value, _ = parse_notice(text)
    assert value["model"] == "vendor/model-1.2:free"
    assert value["fallback"]["from_model"] == "claude-5.5"
    assert value["fallback"]["retry_in_s"] is None


@pytest.mark.asyncio
async def test_real_hermes_success_eviction_does_not_remove_the_detail(setup):
    from gateway.run_turn import GatewayTurnMixin
    a, runner, cached, _ = setup
    agent = live(fallback=True)
    cached["key:one"] = agent
    runner._evict_cached_agent = lambda key: cached.pop(key, None)
    await a.send_or_update_status("one", "lifecycle", MID)
    ctx = SimpleNamespace(session_key="key:one", agent_holder=[agent], result_holder=[{"failed": False}])
    GatewayTurnMixin._run_agent_evict_on_fallback(runner, ctx)
    assert not cached
    assert agent._evicted_on_fallback == "key:one"
    assert a._chat_model("one")["fallback"]["reason"] == "rate limit"


@pytest.mark.asyncio
async def test_http_agent_detail_survives_eviction_but_private_chat_is_not_exposed(setup, tmp_path, aiohttp_client):
    from plugin.hub import Hub
    from plugin.store import Store
    from test_agent import FakeHermes
    from test_trust import pair_phone
    a, runner, cached, _ = setup
    store = Store(tmp_path / "fallback-http.db")
    hub = Hub(store, web_root=tmp_path / "web")
    hub.hermes = FakeHermes()
    hub.chat_model = a._chat_model
    store.ensure_chat("one", "One")
    a._hub = hub
    client = await aiohttp_client(hub.build_app())
    try:
        owner = await pair_phone(client, hub)
        member = await pair_phone(client, hub, "Member", role="member")
        cached["key:one"] = live()
        await a.send_or_update_status("one", "lifecycle", PRE)
        cached.clear()
        runner._last_resolved_model["key:one"] = "gpt-6.1-sol"
        response = await client.get("/api/agent?chat=one", headers=owner.auth)
        assert response.status == 200
        data = await response.json()
        assert data["chat"]["model"] == "gpt-6.1-sol"
        assert data["chat"]["fallback"]["reason"] == "provider unavailable"
        response = await client.get("/api/agent?chat=one", headers=member.auth)
        assert (await response.json())["chat"] is None
    finally:
        await client.close()
        store.close()
