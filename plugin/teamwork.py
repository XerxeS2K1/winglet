"""Teamwork: every bot can ask the others, and make a new one with the owner's OK.

Hermes Desktop's Bot Mode gives a bot its teammates only in its one "Bot Chat" session. These tools give
them to every Winglet chat, delivering the same way Bot Mode does: one turn in the teammate's "Bot Chat"
(``hermes -p <bot> chat -c "Bot Chat"``), signed "Message from 🤖 <name>" for the teammate to read and
authored by the sending bot for Hermes (its memory keeps bot-to-bot turns apart from the human's), so the
teammate keeps that conversation in the same place whichever app started it. Making a bot always waits for an
owner's approval.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from . import hermes_api

logger = logging.getLogger(__name__)

TOOLSET = "bots"
ASK_TIMEOUT_SECONDS = 600
MESSAGE_MAX_CHARS = 8000
MAIN_ALIASES = ("default", "hermes", "main")

# Called (from a worker thread) after a bot is made, so phones hear about it at once.
on_bots_changed: Optional[Callable[[], None]] = None


def _me() -> str:
    """The profile this turn runs as ("default" for the main one)."""
    from hermes_constants import get_hermes_home
    home = get_hermes_home()
    return home.name if home.parent.name == "profiles" else "default"


def _roster() -> List[Dict[str, str]]:
    """Every bot on this server, the main one first."""
    from hermes_cli.profiles import _get_default_hermes_home, read_profile_meta
    meta = read_profile_meta(_get_default_hermes_home())
    main = {"name": "default", "title": meta.get("display_name") or meta.get("bot_title") or "Hermes",
            "description": meta.get("description") or "The main bot"}
    return [main] + [{k: b[k] for k in ("name", "title", "description")} for b in hermes_api.list_bots()]


def _resolve(target: str, roster: List[Dict[str, str]]) -> Optional[Dict[str, str]]:
    want = target.strip().lstrip("@").lower()
    if want in MAIN_ALIASES:
        return roster[0]
    return next((b for b in roster if want in (b["name"].lower(), b["title"].lower())), None)


def _error(message: str, **extra: Any) -> str:
    return json.dumps({"error": message, **extra})


def _handle(profile: str) -> str:
    return "hermes" if profile == "default" else profile


def _author(sender: str) -> Dict[str, Any]:
    """The turn's author as Bot Mode sets it for a teammate on the same install."""
    return {"id": f"bot:{sender}", "name": _handle(sender), "is_bot": True}


def can_deliver() -> bool:
    """This Hermes delivers to a teammate the way Bot Mode does, with the sending bot as the turn's author."""
    try:
        from tools.bot_live_delivery import find_canonical_live_owner, deliver_to_live_owner, await_delivery  # noqa: F401
    except Exception:
        return False
    return True


def _deliver(profile: str, content: str, sender: str) -> dict:
    """Deliver a message to a teammate bot and wait for its reply.

    Uses Hermes's bot_live_delivery (the same door Bot Mode uses): the target profile's own
    gateway runs the turn in its Bot Chat, and we wait on the durable receipt. No subprocess,
    no turn lock (the target's queue serialises turns). Never resend after a timeout or an
    unknown outcome.
    """
    from tools.bot_live_delivery import (
        find_canonical_live_owner, deliver_to_live_owner, await_delivery,
    )
    import uuid

    owner = find_canonical_live_owner(_profile_home(profile))
    if owner is None:
        raise RuntimeError("the target profile has no store yet")
    author = _author(sender)
    delivery_id = uuid.uuid4().hex
    admitted = deliver_to_live_owner(
        _profile_home(profile), owner, content, delivery_id=delivery_id, author=author)
    # admitted may be a refusal (admitted: false) — settle it.
    if not admitted.get("admitted", True):
        from tools.bot_live_delivery import settle_held_delivery
        admitted = settle_held_delivery(_profile_home(profile), owner, content, delivery_id=delivery_id, author=author)
    record = await_delivery(_profile_home(profile), delivery_id, ASK_TIMEOUT_SECONDS)
    if record is None:
        raise RuntimeError("no receipt was ever readable")
    return record


def _profile_home(profile: str):
    from hermes_cli.profiles import get_profile_dir
    return get_profile_dir(profile)


def _note_in_chat(bot_title: str, question: str, answer: str, failed: bool = False) -> None:
    """Leave a small "Asked <bot>" note in the Winglet chat this question came from, carrying the exchange, so
    the owner can open it from the chat. It stays in Winglet's own store (never in Hermes's session), never
    notifies, never holds up the answer, and is skipped quietly anywhere it doesn't apply."""
    try:
        from gateway.session_context import get_session_env
        from . import adapter
        chat = get_session_env("HERMES_SESSION_CHAT_ID")
        active = adapter._ACTIVE
        if get_session_env("HERMES_SESSION_PLATFORM") != "winglet" or not chat:
            return
        if active is None or active._hub is None or active._loop is None or active._hub.store.get_chat(chat) is None:
            return
        meta = {"asked": {"bot": bot_title, "question": question[:2000], "answer": answer[:6000], "failed": failed}}
        future = asyncio.run_coroutine_threadsafe(
            active._hub.post_message(chat, f"Asked {bot_title}", role="system", meta=meta, push=False), active._loop)
        future.add_done_callback(lambda f: f.exception() and logger.debug("[winglet] couldn't note the exchange: %s", f.exception()))
    except Exception:
        logger.debug("[winglet] couldn't note the exchange", exc_info=True)


def _origin_clause() -> str:
    """Label a Winglet hand-off without exposing chat contents or breaking other callers."""
    try:
        from gateway.session_context import get_session_env
        from . import adapter
        if get_session_env("HERMES_SESSION_PLATFORM") != "winglet":
            return ""
        chat_id = get_session_env("HERMES_SESSION_CHAT_ID")
        active = adapter._ACTIVE
        if not chat_id or active is None or active._hub is None:
            return ""
        chat = active._hub.store.get_chat(chat_id)
        title = " ".join(str((chat or {}).get("title") or "").split())[:60]
        if title:
            return f', sent from the chat {json.dumps(title, ensure_ascii=False)}'
    except Exception:
        logger.debug("[winglet] couldn't read the asking chat title", exc_info=True)
    return ""


def ask_bot(args: dict, **_: Any) -> str:
    """Ask another bot on this server, and get its answer."""
    try:
        roster = _roster()
        me = _me()
    except Exception as exc:
        return _error(f"Couldn't list the bots on this server: {exc}")
    target = str(args.get("bot") or "").strip()
    message = str(args.get("message") or "").strip()
    others = [b for b in roster if b["name"] != me]
    if not target:
        return json.dumps({"bots": others})
    bot = _resolve(target, roster)
    if bot is None:
        return _error(f"There's no bot called {target!r} on this server.", bots=others)
    if bot["name"] == me:
        return _error("That's you. Pick another bot.", bots=others)
    if not message:
        return _error("Say what you want from that bot in `message`.")
    if len(message) > MESSAGE_MAX_CHARS:
        return _error(f"That message is too long ({len(message)} characters, at most {MESSAGE_MAX_CHARS}).")
    sender = next((b for b in roster if b["name"] == me), {"title": me})
    # The receipt's reply is the teammate's final text, so tell it to answer here rather than reach for a
    # messaging tool (a bare "reply with X" was taken literally and sent to the asker instead).
    content = (f"Message from 🤖 {sender['title']} (@{_handle(me)}){_origin_clause()}: {message}\n\n"
               "(Answer in your reply to this message. Your reply is returned to the sender automatically, "
               "so do not message anyone.)")
    try:
        record = _deliver(bot["name"], content, me)
    except Exception as exc:
        # find_canonical_live_owner raises ValueError when the authority isn't ready;
        # await_delivery may time out (returns a pending record, not an exception).
        if "authority is not ready" in str(exc).lower() or "not ready" in str(exc).lower():
            return _error(f"{bot['title']} isn't running right now (its gateway authority isn't ready).")
        logger.warning("[winglet] asking %s failed", bot["name"], exc_info=True)
        return _error(f"Couldn't reach {bot['title']}: {exc}")
    # Interpret the receipt record.
    status = record.get("status") if isinstance(record, dict) else None
    if status == "settled":
        reply = (record.get("reply") or "").strip()
        if not reply:
            return _error(f"{bot['title']} couldn't answer.", detail=(record.get("error") or "")[-600:])
        _note_in_chat(bot["title"], message, reply)
        return json.dumps({"bot": bot["title"], "reply": reply})
    if status in ("failed", "cancelled", "ambiguous"):
        detail = (record.get("error") or record.get("reason") or "").strip()[-600:]
        if status == "ambiguous":
            return _error(f"{bot['title']} may have answered, but the result is unclear — don't resend. "
                          f"Detail: {detail}")
        return _error(f"{bot['title']} couldn't answer.", detail=detail)
    # Pending / timeout / unknown.
    if status == "queued" or status == "claimed":
        return _error(f"{bot['title']} is still working; try again in a moment.")
    return _error(f"{bot['title']} didn't answer in time.", detail=str(record)[:600])


def make_bot(args: dict, **_: Any) -> str:
    """Make a new bot on this server, the way Hermes Desktop does (after the owner approved it)."""
    from .hub import _BOT_NAME
    title = str(args.get("title") or "").strip()[:60]
    purpose = str(args.get("purpose") or "").strip()
    name = str(args.get("name") or "").strip().lower() or "-".join(
        "".join(c if c.isalnum() else " " for c in title.lower()).split())[:40]
    if not title:
        return _error("Give the bot a name in `title`.")
    if not _BOT_NAME.fullmatch(name) or name in MAIN_ALIASES:
        return _error("Give it a short name: lowercase letters, numbers and dashes.")
    try:
        bot = hermes_api.create_bot(name, title, f"You are {title}.{f' {purpose}' if purpose else ''}", purpose[:300])
    except hermes_api.HermesRefused as exc:
        return _error(str(exc))
    if on_bots_changed is not None:
        with contextlib.suppress(Exception):
            on_bots_changed()
    return json.dumps({"made": bot, "note": "It shows up in the Winglet app."})


def approve_making_bots(tool_name: str = "", args: Optional[dict] = None, **_: Any) -> Optional[dict]:
    """Making a bot copies provider keys into a new profile: the owner approves each one, like a risky command."""
    if tool_name != "make_bot":
        return None
    title = str((args or {}).get("title") or "a new bot").strip()
    return {"action": "approve", "message": f"Make a new bot, {title}, with your provider keys and model?"}


ASK_SCHEMA = {
    "name": "ask_bot",
    "description": (
        "Ask one of your teammates, the other bots on this Hermes server (each is its own agent with its own "
        "persona, memory and skills), to do something or answer a question, and get its reply. Use it when the "
        "user says 'ask <bot>' or 'tell <bot>', or when a teammate is better placed. Compose the message "
        "yourself and say what you need; don't forward private chat content. Call with an empty `bot` to list "
        "the bots and what each is for. Relay the answer to the user, saying which bot replied."),
    "parameters": {"type": "object", "properties": {
        "bot": {"type": "string", "description": "The bot's name ('hermes' for the main bot), or empty to list them."},
        "message": {"type": "string", "description": "What you want from that bot."},
    }, "required": ["bot"]},
}

MAKE_SCHEMA = {
    "name": "make_bot",
    "description": (
        "Make a new bot on this Hermes server for a job the user describes: a new agent with its own persona, "
        "memory, skills and chats, set up like Hermes Desktop's Create bot (your provider keys and model). The "
        "user approves it before it's made. Use it only when the user asks for a new bot."),
    "parameters": {"type": "object", "properties": {
        "title": {"type": "string", "description": "What the bot is called, e.g. 'Chef'."},
        "purpose": {"type": "string", "description": "What it's for, in a sentence or two; this becomes its persona."},
        "name": {"type": "string", "description": "Optional short name (lowercase, dashes); made from the title if left out."},
    }, "required": ["title", "purpose"]},
}


def register(ctx) -> None:
    """Add the tools to Hermes (a "bots" toolset, on by default like other plugin toolsets) and the approval
    gate for making bots. Never fatal: without it, bots still work, they just don't call each other."""
    available = hermes_api.bots_available
    try:
        ctx.register_tool(name="ask_bot", toolset=TOOLSET, schema=ASK_SCHEMA, handler=ask_bot,
                          check_fn=lambda: available() and can_deliver(),
                          description="Ask another bot on this server", emoji="🤝")
        ctx.register_tool(name="make_bot", toolset=TOOLSET, schema=MAKE_SCHEMA, handler=make_bot, check_fn=available,
                          description="Make a new bot on this server", emoji="🐣")
        ctx.register_hook("pre_tool_call", approve_making_bots)
        # Hermes drops a tool whose check_fn is false without a word, so say why ask_bot would be missing.
        if not can_deliver():
            logger.warning("[winglet] ask_bot is off: this Hermes has no tools.bot_live_delivery (needs v0.22.5 or later)")
        elif not available():
            logger.info("[winglet] ask_bot and make_bot are off: Hermes isn't serving more than one bot profile")
    except Exception:
        logger.warning("[winglet] couldn't add the bot teamwork tools", exc_info=True)
