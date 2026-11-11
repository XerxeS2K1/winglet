"""Exercise the real adapter with small Hermes interface doubles, without installing the gateway."""

import asyncio
import builtins
import copy
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from plugin import bridge
from plugin.hub import Hub
from plugin.store import Store


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    class BaseAdapter:
        async def send_exec_approval(self, chat_id, command, session_key, description=None,
                                     metadata=None, allow_permanent=True, allow_session=True,
                                     smart_denied=False):
            return await self._send_exec_approval_prompt(prompt(
                chat_id=chat_id, command=command, session_key=session_key, description=description,
                metadata=metadata, smart_denied=smart_denied))

    shared = {name: lambda *args, **kwargs: None for name in
              ("extra_or_secret", "get_scoped_secret", "seed_extra_from_env")}
    interfaces = {
        "gateway": {}, "gateway.platforms": {},
        "gateway.config": {"Platform": str, "PlatformConfig": object},
        "gateway.platforms._shared": shared,
        "gateway.platforms.base": {"BasePlatformAdapter": BaseAdapter, "ExecApprovalPrompt": SimpleNamespace,
                                   "SendResult": SimpleNamespace},
        "gateway.platforms.event": {"MessageEvent": SimpleNamespace, "MessageType": SimpleNamespace},
    }
    for name, members in interfaces.items():
        module = ModuleType(name)
        module.__dict__.update(members)
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location("plugin._approval_test_adapter",
                                                 Path(__file__).parents[1] / "plugin" / "adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.WingletAdapter.__new__(module.WingletAdapter)
    store = Store(tmp_path / "adapter.db")
    instance.name = "Winglet"
    instance._hub = Hub(store)
    yield instance
    awaitable_tasks = list(instance._hub._push_tasks.values())
    for task in awaitable_tasks:
        task.cancel()
    store.close()


@pytest.fixture
def notifier():
    # Model Hermes' synchronous call site, including the real module/frame/context names.
    # Return the coroutine without running it: by the time the loop receives it this frame is gone.
    module = ModuleType("gateway.run_turn_runner")
    module.namespace = SimpleNamespace
    exec("""
class TurnRunner:
    def __init__(self, adapter, session_key="s1", chat_id="general"):
        self._ctx = namespace(_status_adapter=adapter, session_key=session_key, _status_chat_id=chat_id)

    def _approval_notify_sync(self, approval_data, target=None, **overrides):
        ctx = self._ctx
        arguments = dict(chat_id=ctx._status_chat_id, command=approval_data["command"],
                         session_key=ctx.session_key, metadata=approval_data.get("metadata"))
        arguments.update(overrides)
        return (target or ctx._status_adapter).send_exec_approval(**arguments)

    def changed_notifier(self, approval_data):
        ctx = self._ctx
        return ctx._status_adapter.send_exec_approval(
            chat_id=ctx._status_chat_id, command=approval_data["command"], session_key=ctx.session_key)
""", module.__dict__)
    return module.TurnRunner


@pytest.fixture
def split_notifier():
    # Hermes 0.22.5 shape: the notifier delegates to _render_approval_sync, which calls the adapter.
    module = ModuleType("gateway.run_turn_runner")
    module.namespace = SimpleNamespace
    exec("""
class TurnRunner:
    def __init__(self, adapter, session_key="s1", chat_id="general"):
        self._ctx = namespace(_status_adapter=adapter, session_key=session_key, _status_chat_id=chat_id)

    def _approval_notify_sync(self, approval_data):
        return self._render_approval_sync(approval_data)

    def _render_approval_sync(self, approval_data):
        ctx = self._ctx
        adapter = ctx._status_adapter
        return adapter.send_exec_approval(
            chat_id=ctx._status_chat_id, command=approval_data["command"], session_key=ctx.session_key,
            metadata=None)
""", module.__dict__)
    return module.TurnRunner


async def test_identity_is_captured_from_the_split_render_call_site(adapter, split_notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    result = await split_notifier(adapter)._approval_notify_sync({"request_id": "a", "command": "ls"})
    assert result.success
    assert adapter._hub.store.pending_items("approval")[0]["payload"]["request_id"] == "a"


async def test_split_render_call_site_from_another_module_cannot_supply_identity(adapter, split_notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    monkeypatch.setitem(split_notifier._render_approval_sync.__globals__, "__name__", "other.gateway")
    assert not (await split_notifier(adapter)._approval_notify_sync({"request_id": "a", "command": "ls"})).success
    assert adapter._hub.store.pending_count() == 0


def prompt(**overrides):
    values = {"chat_id": "general", "session_key": "s1", "command": "ls", "description": "Inspect",
              "metadata": {}, "actions": [("Allow once", "once", "primary"), ("Deny", "deny", "danger")],
              "choices": ["once", "deny"], "smart_denied": False}
    return SimpleNamespace(**(values | overrides))


def test_registration_still_exposes_setup_when_server_dependencies_are_missing(adapter, monkeypatch):
    original_import = builtins.__import__
    def guarded_import(name, *args, **kwargs):
        if name == "hub" or name.split(".")[0] in {"aiohttp", "cryptography", "httpx", "qrcode"}:
            raise ModuleNotFoundError(name)
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded_import)
    spec = importlib.util.spec_from_file_location("plugin._dependency_test_adapter",
                                                 Path(__file__).parents[1] / "plugin" / "adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    registrations = {}
    context = SimpleNamespace(
        register_platform=lambda **kwargs: registrations.update(platform=kwargs),
        register_cli_command=lambda **kwargs: registrations.update(cli=kwargs))
    module.register(context)
    assert registrations["cli"]["name"] == "winglet"
    assert registrations["platform"]["install_hint"] == "hermes winglet setup"
    assert registrations["platform"]["parse_target_ref_fn"]("home") == ("home", None)

    # A Hermes that doesn't know target parsers still registers the platform.
    def older(**kwargs):
        if "parse_target_ref_fn" in kwargs:
            raise TypeError("unexpected keyword argument 'parse_target_ref_fn'")
        registrations.update(platform=kwargs)
    registrations.clear()
    module.register(SimpleNamespace(register_platform=older, register_cli_command=lambda **kwargs: None))
    assert registrations["platform"]["name"] == "winglet"


async def test_missing_or_withdrawn_identity_never_creates_an_actionable_card(adapter, monkeypatch):
    queue = [{"request_id": "replacement", "command": "ls"}]
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: queue)
    for p in (prompt(), prompt(metadata={"approval_request_id": "withdrawn"}),
              prompt(command="harmless", metadata={"request_id": "replacement"})):
        result = await adapter._send_exec_approval_prompt(p)
        assert result.success is False  # Hermes uses its existing typed approval fallback
    assert adapter._hub.store.pending_count() == 0
    assert adapter._hub.store.list_messages("general") == []
    assert adapter._hub._http is None


async def test_normal_escalation_keeps_hermes_supplied_choices(adapter, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    choices = ["once", "session", "always", "deny"]
    actions = [(c, c, "secondary") for c in choices]
    assert (await adapter._send_exec_approval_prompt(prompt(
        metadata={"approval_request_id": "a"}, smart_denied=False, actions=actions, choices=choices))).success
    payload = adapter._hub.store.pending_items("approval")[0]["payload"]
    assert payload["smart_denied"] is False
    assert payload["choices"] == choices


async def test_smart_denial_card_does_not_offer_broad_approval(adapter, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    actions = [("Allow once", "once", "primary"), ("Allow session", "session", "secondary"),
               ("Always", "always", "secondary"), ("Deny", "deny", "danger")]
    p = prompt(metadata={"approval_request_id": "a"}, smart_denied=True, actions=actions,
               choices=["once", "session", "always", "deny"])
    assert (await adapter._send_exec_approval_prompt(p)).success
    payload = adapter._hub.store.pending_items("approval")[0]["payload"]
    assert payload["smart_denied"] is True
    assert payload["choices"] == ["once", "deny"]
    calls = []
    async def respond(item, choice):
        calls.append(choice)
        return True
    adapter._hub.on_approval = respond
    item = adapter._hub.store.pending_items("approval")[0]
    assert not (await adapter._hub.respond(item["id"], choice="session"))[0]
    assert not (await adapter._hub.respond(item["id"], choice="always"))[0]
    assert calls == []


async def test_identical_commands_bind_and_resolve_only_the_supplied_id(adapter, monkeypatch):
    queue = [{"request_id": "a", "command": "ls"}, {"request_id": "b", "command": "ls"}]
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: queue)
    resolved = []
    monkeypatch.setattr(bridge, "resolve_approval", lambda session, identity, choice:
                        resolved.append((session, identity, choice)) or True)
    adapter._hub.on_approval = adapter._on_approval
    for identity in ("b", "a"):
        result = await adapter._send_exec_approval_prompt(prompt(metadata={"approval_request_id": identity}))
        assert result.success
    items = adapter._hub.store.pending_items("approval")
    card_b = next(i for i in items if i["payload"]["request_id"] == "b")
    ok, _ = await adapter._hub.respond(card_b["id"], choice="once")
    assert ok and resolved == [("s1", "b", "once")]
    assert adapter._hub.store.pending_count() == 1


async def test_already_claimed_identity_cannot_create_a_duplicate_card(adapter, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    p = prompt(request_id="a")
    assert (await adapter._send_exec_approval_prompt(p)).success
    assert not (await adapter._send_exec_approval_prompt(p)).success
    assert adapter._hub.store.pending_count() == 1


async def test_notifier_captures_exact_identity_before_worker_frame_disappears(adapter, notifier, monkeypatch):
    queue = [{"request_id": "a", "command": "ls"}, {"request_id": "b", "command": "ls"}]
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: queue)
    data = {"request_id": "b", "command": "ls", "metadata": {"thread_id": "t1"}}
    coroutine = await asyncio.to_thread(notifier(adapter)._approval_notify_sync, data)
    # Neither later mutation nor two identical queued commands can change the captured identity.
    data["request_id"] = "a"
    assert data["metadata"] == {"thread_id": "t1"}
    assert (await coroutine).success
    assert adapter._hub.store.pending_items("approval")[0]["payload"]["request_id"] == "b"


async def test_notifier_withdrawn_request_never_binds_identical_replacement(adapter, notifier, monkeypatch):
    queue = [{"request_id": "original", "command": "ls"}]
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: queue)
    coroutine = notifier(adapter)._approval_notify_sync({"request_id": "original", "command": "ls"})
    queue[:] = [{"request_id": "replacement", "command": "ls"}]
    assert not (await coroutine).success
    assert adapter._hub.store.pending_count() == 0


async def test_changed_or_missing_notifier_identity_uses_typed_flow(adapter, notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    data = {"request_id": "a", "command": "ls"}
    runner = notifier(adapter)
    assert not (await runner.changed_notifier(data)).success
    assert not (await adapter.send_exec_approval("general", "ls", "s1")).success
    for identity in (None, "", 42):
        assert not (await runner._approval_notify_sync(data | {"request_id": identity})).success
    assert adapter._hub.store.pending_count() == 0


async def test_notifier_wrong_session_chat_or_adapter_cannot_supply_identity(adapter, notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    runner = notifier(adapter)
    data = {"request_id": "a", "command": "ls"}
    assert not (await runner._approval_notify_sync(data, session_key="other")).success
    assert not (await runner._approval_notify_sync(data, chat_id="other")).success
    assert not (await runner._approval_notify_sync(data, target=copy.copy(adapter))).success

    class Relay:
        def send_exec_approval(self, **kwargs):
            # Even matching arguments through an intermediary are not the immediate notifier call.
            return adapter.send_exec_approval(**kwargs)

    assert not (await notifier(Relay())._approval_notify_sync(data)).success
    assert adapter._hub.store.pending_count() == 0


async def test_same_named_notifier_from_another_module_cannot_supply_identity(adapter, notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: [{"request_id": "a", "command": "ls"}])
    monkeypatch.setitem(notifier._approval_notify_sync.__globals__, "__name__", "other.gateway")
    assert not (await notifier(adapter)._approval_notify_sync({"request_id": "a", "command": "ls"})).success
    assert adapter._hub.store.pending_count() == 0


async def test_explicit_identity_wins_and_invalid_supplied_identity_does_not_capture(adapter, notifier, monkeypatch):
    queue = [{"request_id": "a", "command": "ls"}, {"request_id": "b", "command": "ls"}]
    monkeypatch.setattr(bridge, "queued_approvals", lambda session: queue)
    data = {"request_id": "a", "command": "ls"}
    runner = notifier(adapter)
    assert (await runner._approval_notify_sync(data, request_id="b")).success
    for identity in (None, "", "withdrawn"):
        assert not (await runner._approval_notify_sync(
            data, metadata={"approval_request_id": identity})).success
    assert adapter._hub.store.pending_count() == 1


async def test_parallel_sessions_keep_their_notified_identities(adapter, notifier, monkeypatch):
    monkeypatch.setattr(bridge, "queued_approvals", lambda session:
                        [{"request_id": session, "command": "ls"}])
    coroutines = await asyncio.gather(*[
        asyncio.to_thread(notifier(adapter, session)._approval_notify_sync,
                          {"request_id": session, "command": "ls"}) for session in ("s1", "s2")])
    assert all(result.success for result in await asyncio.gather(*coroutines))
    assert {(i["payload"]["session_key"], i["payload"]["request_id"])
            for i in adapter._hub.store.pending_items("approval")} == {("s1", "s1"), ("s2", "s2")}


async def test_frame_access_unavailable_falls_back(adapter, notifier, monkeypatch):
    def unavailable(depth):
        raise ValueError("frame unavailable")

    monkeypatch.setattr(bridge.sys, "_getframe", unavailable)
    assert not (await notifier(adapter)._approval_notify_sync({"request_id": "a", "command": "ls"})).success
    assert adapter._hub.store.pending_count() == 0


async def test_a_members_tools_fail_closed(adapter):
    store = adapter._hub.store
    owner, _ = store.add_device("Pixel", "android", role="owner")
    member, _ = store.add_device("Alex", "android", role="member")
    store.set_kv("member_tools", '{"limited": true, "toolsets": ["web"]}')

    class Broken:
        NO_TOOLS = ["no_mcp"]

        def member_toolsets(self, allowed, mcp):
            raise RuntimeError("config unreadable")

    adapter._hub.hermes = Broken()
    source = lambda user_id, platform="winglet": SimpleNamespace(user_id=user_id, platform=SimpleNamespace(value=platform))  # noqa: E731
    assert adapter.toolsets_for_source(source("winglet:" + owner["id"])) is None
    assert adapter.toolsets_for_source(source("webhook:route")) is None
    assert adapter.toolsets_for_source(source("winglet:" + member["id"])) == ["no_mcp"]

    # The cap on Hermes's final result: nothing for a member when the limit can't be worked out.
    assert adapter.toolset_limit(source("winglet:" + owner["id"])) is None
    assert adapter.toolset_limit(source("winglet:" + member["id"], "telegram")) is None
    assert adapter.toolset_limit(source("winglet:" + member["id"])) == set()

    class Working(Broken):
        def member_toolsets(self, allowed, mcp):
            return sorted(allowed) + ["no_mcp"]
    adapter._hub.hermes = Working()
    assert adapter.toolset_limit(source("winglet:" + member["id"])) == {"web"}
    hub, adapter._hub = adapter._hub, None
    assert adapter.toolset_limit(source("winglet:" + member["id"])) == set()
    adapter._hub = hub


def test_a_deleted_general_chat_stays_deleted_across_a_restart(adapter):
    module = SimpleNamespace(**type(adapter).__init__.__globals__)
    store = adapter._hub.store
    module.ensure_general_chat(store)
    assert store.get_chat(module.GENERAL_CHAT_ID) is not None  # a new server gets General
    assert store.delete_chat(module.GENERAL_CHAT_ID)
    module.ensure_general_chat(store)  # the next start-up
    assert store.get_chat(module.GENERAL_CHAT_ID) is None
