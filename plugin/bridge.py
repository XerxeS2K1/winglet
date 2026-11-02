"""Small, defensive calls into Hermes' approval and clarify queues.

Kept apart from the adapter so the matching logic can be tested without a running gateway, and so a
Hermes version that lacks one of these functions degrades to "can't answer from Winglet" instead of
answering the wrong request.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any, Dict, Iterable, List, Optional, Set

logger = logging.getLogger(__name__)


# Hermes' synchronous call sites for the approval prompt. Older builds call the adapter straight
# from the notifier; newer builds (0.22.5) split rendering into ``_render_approval_sync``.
_NOTIFIER_FRAMES = frozenset({"_approval_notify_sync", "_render_approval_sync"})


def notified_request_id(adapter: Any, chat_id: str, session_key: str) -> Optional[str]:
    """Capture identity at Hermes' synchronous adapter call, before crossing to the loop.

    Current Hermes has the ID in ``approval_data`` but omits it from the adapter arguments.
    Only its immediate, known notifier frame (see ``_NOTIFIER_FRAMES``) for this adapter/chat/session is accepted. A changed
    call path returns None and uses typed approval; we never search the stack or infer from a queue.
    This helper must be called directly by the synchronous ``send_exec_approval`` wrapper.
    """
    caller = None
    try:
        caller = sys._getframe(2)
        if (caller.f_globals.get("__name__") != "gateway.run_turn_runner"
                or caller.f_code.co_name not in _NOTIFIER_FRAMES):
            return None
        ctx = caller.f_locals.get("ctx")
        if (ctx is None or getattr(caller.f_locals.get("self"), "_ctx", None) is not ctx
                or getattr(ctx, "_status_adapter", None) is not adapter
                or not session_key or getattr(ctx, "session_key", None) != session_key
                or getattr(ctx, "_status_chat_id", None) != chat_id):
            return None
        data = caller.f_locals.get("approval_data")
        identity = data.get("request_id") if isinstance(data, dict) else None
        return identity if isinstance(identity, str) and identity else None
    except (AttributeError, ValueError):
        # Frame access is unavailable on some runtimes, or the caller no longer has this shape.
        return None
    finally:
        del caller  # Do not retain Hermes' worker frame, request data, or context.


def pick_request_id(entries: Iterable[Dict[str, Any]], request_id: Any, claimed: Set[str]) -> Optional[str]:
    """Validate the identity supplied with this prompt; never infer it from command text.

    Even a unique command match can belong to a replacement request after the original timed out.
    A missing identity must use Hermes' text approval flow instead of interactive cards.
    """
    if not isinstance(request_id, str) or not request_id or request_id in claimed:
        return None
    return request_id if any(e.get("request_id") == request_id for e in entries) else None


def queued_approvals(session_key: str) -> Optional[List[Dict[str, Any]]]:
    """Snapshots of the session's waiting approvals, or None when this Hermes can't list them."""
    try:
        from tools.approval import list_gateway_approvals
    except ImportError:
        return None
    try:
        return list(list_gateway_approvals(session_key))
    except Exception:
        logger.debug("[winglet] could not list approvals", exc_info=True)
        return None


def resolve_approval(session_key: str, request_id: str, choice: str) -> bool:
    """Answer exactly one request. Never falls back to "oldest in the queue"."""
    if not session_key or not request_id:
        return False
    from tools.approval import resolve_gateway_approval
    return resolve_gateway_approval(session_key, choice, request_id=request_id) > 0


def clarify_pending(clarify_id: str) -> Optional[bool]:
    """True while Hermes still waits on this question; None when it can't be checked."""
    try:
        from tools import clarify_gateway as cg
        with cg._lock:
            entry = cg._entries.get(clarify_id)
            return entry is not None and not entry.event.is_set()
    except Exception:
        return None


def clarify_answer(answer: Any, multi_select: bool) -> str:
    """Hermes takes a multi-select answer as a JSON array of the chosen labels."""
    if multi_select:
        picked = answer if isinstance(answer, list) else [answer]
        return json.dumps([str(a) for a in picked if str(a).strip()], ensure_ascii=False)
    return str(answer)


def resolve_clarify(clarify_id: str, answer: str) -> bool:
    if not clarify_id:
        return False
    from tools.clarify_gateway import resolve_gateway_clarify
    return bool(resolve_gateway_clarify(clarify_id, answer))
