"""Optional real-source handoff check: set HERMES_SOURCE to an unmodified Hermes checkout.

Execute its notifier, prompt dataclass, and base send method without booting a model or gateway.
Only surrounding rendering/transport dependencies are doubled; the synchronous -> async call
and the production Winglet adapter are real. Normal CI exercises the unit handoff cases instead.
"""

import ast
import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

import pytest

from plugin import bridge
from test_adapter_approvals import adapter  # noqa: F401 - shared fixture loads the production adapter


def source_nodes(root, path, class_name, members):
    tree = ast.parse((root / path).read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    if members is None:
        return [cls]
    return [node for node in cls.body if getattr(node, "name", None) in members]


def execute(nodes, module):
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    tree = ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[]))
    exec(compile(tree, "<Hermes source handoff>", "exec"), module.__dict__)


async def test_actual_hermes_notifier_and_base_prompt_handoff(adapter, monkeypatch):
    location = os.environ.get("HERMES_SOURCE")
    if not location:
        pytest.skip("set HERMES_SOURCE to test against actual Hermes source")
    root = Path(location)
    base = sys.modules["gateway.platforms.base"]
    base.__dict__.update(dataclass=dataclass, List=List, Tuple=Tuple, Dict=Dict, Any=Any, Optional=Optional,
                         ea_default_reason_text=lambda: "Approval needed")
    execute(source_nodes(root, "gateway/platforms/base.py", "ExecApprovalPrompt", None), base)
    execute(source_nodes(root, "gateway/platforms/base.py", "BasePlatformAdapter", {"send_exec_approval"}), base)
    monkeypatch.setattr(base.BasePlatformAdapter, "send_exec_approval", base.send_exec_approval)
    adapter._format_exec_approval = lambda *args: "Approval needed"
    adapter._exec_approval_actions = lambda **kwargs: [("Allow once", "once", "primary"), ("Deny", "deny", "danger")]
    adapter.pause_typing_for_chat = lambda chat: None

    notices = []
    settle = ModuleType("gateway.run_turn_runner_approval_settle")
    settle.register_timeout_notice = lambda *args, **kwargs: notices.append(kwargs)
    monkeypatch.setitem(sys.modules, settle.__name__, settle)
    run = ModuleType("gateway.run")
    run._approval_send_outcome = lambda future, timeout: "sent" if future.result(timeout).success else "failed"
    run._format_exec_approval_fallback = lambda *args, **kwargs: "Use /approve or /deny"
    run._interim_metadata = lambda metadata: metadata
    run._redact_approval_command = lambda command: command.replace("secret", "[REDACTED]")
    monkeypatch.setitem(sys.modules, run.__name__, run)

    notifier = ModuleType("gateway.run_turn_runner")
    notifier.__dict__.update(logger=logging.getLogger(__name__), ea_default_reason_text=lambda: "Approval needed",
                             _renders_exec_approval_buttons=lambda cls: True, _ExecApprovalDeclined=RuntimeError)
    execute(source_nodes(root, "gateway/run_turn_runner.py", "TurnRunner", {"_approval_notify_sync", "_render_approval_sync"}), notifier)
    loop = asyncio.get_running_loop()
    runner = SimpleNamespace(_ctx=SimpleNamespace(_status_adapter=adapter, _status_chat_id="general",
                                                  session_key="s1", _status_thread_metadata={"thread_id": "t1"}),
                             _close_native_stream_boundary=lambda *args: None,
                             _schedule=lambda coroutine, *args: asyncio.run_coroutine_threadsafe(coroutine, loop),
                             _approval_owner=None)
    # Newer Hermes (0.22.5) delegates to a separate render method; bind it when the source has one.
    if hasattr(notifier, "_render_approval_sync"):
        runner._render_approval_sync = lambda data: notifier._render_approval_sync(runner, data)
    monkeypatch.setattr(bridge, "queued_approvals", lambda session:
                        [{"request_id": "a", "command": "echo secret"}, {"request_id": "b", "command": "echo secret"}])

    await asyncio.to_thread(notifier._approval_notify_sync, runner,
                            {"request_id": "b", "command": "echo secret", "description": "Inspect"})
    card = adapter._hub.store.pending_items("approval")[0]
    assert card["payload"]["request_id"] == "b"
    assert card["payload"]["command"] == "echo [REDACTED]"
    assert runner._ctx._status_thread_metadata == {"thread_id": "t1"}
    assert notices[0]["card_message_id"] is not None

    # Actual Hermes takes its typed fallback when Winglet cannot validate the original ID.
    await asyncio.to_thread(notifier._approval_notify_sync, runner,
                            {"request_id": "withdrawn", "command": "echo secret", "description": "Inspect"})
    assert adapter._hub.store.pending_count() == 1
    assert adapter._hub.store.list_messages("general")[-1]["text"] == "Use /approve or /deny"
    assert notices[-1]["card_message_id"] is None
