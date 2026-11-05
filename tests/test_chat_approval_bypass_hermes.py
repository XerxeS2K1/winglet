""""Allow everything in this chat" against the installed Hermes command gate, notifier and
per-session bypass (tools.approval session yolo), through Winglet's adapter, hub and signed answer.

Session keys are not mocked: the adapter's real ``_session_key`` builds them with Hermes's own
``GatewayRunner._session_key_for_source`` and ``build_session_key``, and they are checked against the
key of the source Winglet's inbound message path hands Hermes. No command is executed; only the gate
decides. Collected by the "Plugin tests with Hermes" CI job; skipped where Hermes isn't installed.
"""
import asyncio
import os
import sys
from types import SimpleNamespace

import pytest

pytest.importorskip("gateway.run_turn_runner")


def _gateway_runner():
    """Import Hermes's gateway runner without keeping what its import writes process-wide
    (``_HERMES_GATEWAY``, ``HERMES_QUIET``, its dotenv, ``sys.path``): those change how the other
    Hermes integration tests in this run behave."""
    env, path = dict(os.environ), list(sys.path)
    try:
        from gateway.run import GatewayRunner
    except ImportError:
        pytest.skip("gateway.run is not importable", allow_module_level=True)
    finally:
        os.environ.clear()
        os.environ.update(env)
        sys.path[:] = path
    return GatewayRunner


GatewayRunner = _gateway_runner()
from gateway.run_turn_runner import TurnRunner
from tools import approval, approval_context
from plugin import bridge
from plugin.adapter import WingletAdapter
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone, post_signed

COMMAND = "python -c 'print(123)'"  # Hermes flags script execution; never run it.
HARDLINE = "rm -rf /"
ALL_CHOICES = ["once", "session", "always", "deny"]


class Runner:
    """Just enough of a gateway runner for Hermes's own session-key resolver to run unchanged."""
    session_store = None
    config = SimpleNamespace(multiplex_profiles=True, group_sessions_per_user=True,
                             thread_sessions_per_user=False)
    _session_key_for_source = GatewayRunner._session_key_for_source

    def _profile_name_for_source(self, source, adapter_profile=None):
        return adapter_profile  # no profile_routes configured


@pytest.fixture
async def gateway(tmp_path, monkeypatch, aiohttp_client):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "config.yaml").write_text("approvals:\n  mode: manual\n  timeout: 30\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    store = Store(tmp_path / "winglet.db")
    for chat_id, title, bot in (("general", "General", None), ("other", "Other", None), ("work-chat", "Work", "work")):
        store.ensure_chat(chat_id, title, bot=bot)
    hub = Hub(store, web_root=tmp_path / "web")
    adapter = WingletAdapter.__new__(WingletAdapter)
    adapter.platform = SimpleNamespace(value="winglet")  # as in test_smart_approvals_hermes
    adapter._hub = hub
    adapter._typing_paused = set()
    runner = adapter.gateway_runner = Runner()
    # Hermes serves the "work" profile through a Winglet adapter of its own, which stamps that profile on its sources.
    work = WingletAdapter.__new__(WingletAdapter)
    work.platform = adapter.platform
    work._hub = hub
    work._typing_paused = set()
    work._hermes_profile_name = "work"
    work._owner_profile = "work"  # what Hermes's set_owner_profile does for a bot's adapter
    work.gateway_runner = runner
    runner.adapters = {"winglet": adapter}
    runner._profile_adapters = {"work": {"winglet": work}}
    hub.on_approval = adapter._on_approval
    hub.chat_approval_bypass = bridge.chat_approval_bypass(adapter)
    assert hub.chat_approval_bypass is not None
    client = await aiohttp_client(hub.build_app())
    phone = await pair_phone(client, hub)
    loop = asyncio.get_running_loop()
    keys = {chat: adapter._session_key(chat) for chat in ("general", "other", "work-chat")}
    for chat, key in keys.items():
        ctx = SimpleNamespace(_status_adapter=adapter, _status_chat_id=chat, session_key=key,
                              _status_thread_metadata=None, stream_consumer_holder=None, _loop_for_step=loop)
        approval.register_gateway_notify(key, TurnRunner(None, ctx)._approval_notify_sync)
    yield SimpleNamespace(store=store, hub=hub, client=client, phone=phone, adapter=adapter, work=work, keys=keys)
    for key in keys.values():
        approval.resolve_gateway_approval(key, "deny", resolve_all=True)  # unblock a failed test
        approval.unregister_gateway_notify(key)
        approval.clear_session(key)  # also drops this test's session yolo
    for task in list(hub._push_tasks.values()):
        task.cancel()
    store.close()


def gate(session_key, command=COMMAND):
    token = approval_context.set_current_session_key(session_key)
    try:
        return approval.check_all_command_guards(command, "local")
    finally:
        approval_context.reset_current_session_key(token)


def start_gate(session_key, command=COMMAND):
    return asyncio.create_task(asyncio.to_thread(gate, session_key, command))


async def next_card(g, task, *, seen=()):
    async def wait():
        while True:
            cards = [c for c in g.store.pending_items("approval") if c["id"] not in seen]
            if cards:
                return cards[0]
            if task.done():
                raise AssertionError(f"Gate returned without a card: {task.result()!r}")
            await asyncio.sleep(0.01)
    return await asyncio.wait_for(wait(), timeout=10)


async def answer(g, card, choice, **extra):
    return await post_signed(g.client, g.phone, f"/api/inbox/{card['id']}/respond", {"choice": choice, **extra})


async def test_bypass_key_is_the_inbound_session_and_distinct_per_chat_and_profile(gateway):
    g = gateway
    events = []

    async def capture(event):
        events.append(event)
    g.adapter.handle_message = capture
    g.work.handle_message = capture  # a bot's chat is handled by that bot's own adapter
    device = {"id": "dev1", "name": "Pixel"}
    for chat in ("general", "other", "work-chat"):
        await g.adapter._on_user_message(g.store.get_chat(chat), "hi", device, {"id": "m-" + chat})
    inbound = {e.source.chat_id: g.adapter.gateway_runner._session_key_for_source(e.source) for e in events}
    assert inbound == g.keys
    assert len(set(g.keys.values())) == 3
    assert g.keys["work-chat"].startswith("agent:work:")
    assert not g.keys["general"].startswith("agent:work:")
    assert g.hub.chat_approval_bypass.session_key("general") == g.keys["general"]


async def test_allow_all_runs_the_session_without_asking_until_turned_off(gateway):
    g = gateway
    general, other = g.keys["general"], g.keys["other"]
    task = start_gate(general)
    card = await next_card(g, task)
    assert card["chat_id"] == "general" and card["payload"]["session_key"] == general
    assert card["payload"]["smart_denied"] is False
    response = await answer(g, card, "once", allow_all=True, chat_id="general")
    assert response.status == 200, await response.text()
    assert (await asyncio.wait_for(task, 10))["approved"] is True
    assert approval.is_session_yolo_enabled(general) and not approval.is_session_yolo_enabled(other)

    # Later commands in that session don't ask.
    assert (await asyncio.wait_for(asyncio.to_thread(gate, general), 10))["approved"] is True
    assert g.store.pending_items("approval") == []
    # Hermes's hardline floor still blocks, without a card.
    blocked = await asyncio.wait_for(asyncio.to_thread(gate, general, HARDLINE), 10)
    assert blocked["approved"] is False and g.store.pending_items("approval") == []
    # Another chat's session still asks.
    task = start_gate(other)
    card = await next_card(g, task)
    assert card["chat_id"] == "other"
    assert (await answer(g, card, "deny")).status == 200
    assert (await asyncio.wait_for(task, 10))["approved"] is False

    response = await g.client.get("/api/chats/general/approval-bypass", headers=g.phone.auth)
    assert (await response.json())["enabled"] is True
    path = "/api/chats/general/approval-bypass"
    assert (await g.client.delete(path, headers=g.phone.signed("DELETE", path))).status == 200
    assert not approval.is_session_yolo_enabled(general)
    # Turned back on: the next command asks again.
    task = start_gate(general)
    card = await next_card(g, task)
    assert (await answer(g, card, "deny")).status == 200
    assert (await asyncio.wait_for(task, 10))["approved"] is False
    actions = [row["action"] for row in g.store.list_audit()]
    assert actions.count("approval_bypass.on") == 1 and actions.count("approval_bypass.off") == 1


async def test_a_command_in_the_resolve_window_gets_a_normal_card(gateway):
    """Hermes wakes the approved worker inside resolve; Winglet turns the bypass on only afterwards.
    A command arriving in between must get an ordinary card: not approved silently, and not stuck."""
    g = gateway
    general = g.keys["general"]
    resolve = g.hub.on_approval
    window = {}

    async def resolve_then_next_command(item, choice):
        ok = await resolve(item, choice)
        window["bypass_on"] = approval.is_session_yolo_enabled(general)
        window["task"] = start_gate(general)
        window["card"] = await next_card(g, window["task"], seen={item["id"]})
        return ok
    g.hub.on_approval = resolve_then_next_command
    task = start_gate(general)
    card = await next_card(g, task)
    response = await answer(g, card, "once", allow_all=True, chat_id="general")
    assert response.status == 200, await response.text()
    assert (await asyncio.wait_for(task, 10))["approved"] is True
    assert window["bypass_on"] is False
    assert approval.is_session_yolo_enabled(general)  # on now, for what comes next
    late = g.store.get_inbox(window["card"]["id"])
    assert late["status"] == "pending" and late["payload"]["smart_denied"] is False
    assert late["payload"]["choices"] == ALL_CHOICES
    await asyncio.sleep(0.2)
    assert not window["task"].done()  # turning the bypass on did not approve the waiting command
    g.hub.on_approval = resolve
    assert (await answer(g, late, "deny")).status == 200
    assert (await asyncio.wait_for(window["task"], 10))["approved"] is False
