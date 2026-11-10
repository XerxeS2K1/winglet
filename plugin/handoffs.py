"""Durable, human-only completion notices for Winglet hand-offs. Never resend or wake an agent."""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata

logger = logging.getLogger(__name__)

TITLE_MAX = 50      # the short title a calling agent gives a hand-off
FALLBACK_MAX = 60   # the first line of the request, when there is no title
# Hermes admits a hand-off as "bot:" + the delivery id Winglet chose (and the same id with ":retry" for its one retry).
_REQUEST_ID = re.compile(r"bot:([0-9a-f]{32,64})(?::retry)?")


def _plain(text: str) -> str:
    """One line of plain text: whitespace (including line separators) collapsed; control, format and zero-width
    characters removed, so nothing can hide, reorder or reshape what the owner reads."""
    kept = (" " if ch.isspace() else ch for ch in text if ch.isspace() or not unicodedata.category(ch).startswith("C"))
    return " ".join("".join(kept).split())


def clean_title(raw) -> str:
    """A hand-off title as the sender's untrusted text: plain, one line, cut (never refused) at TITLE_MAX characters."""
    return _plain(raw)[:TITLE_MAX].rstrip() if isinstance(raw, str) else ""


_TITLE_LABEL = re.compile(r"title\s*:\s*(.*)", re.IGNORECASE)


def first_line_title(text) -> str:
    """What a request with no title argument is called: a leading "TITLE: ..." line (the convention for hand-offs sent
    with Hermes's own message_agent), else its first non-empty line cut at FALLBACK_MAX characters at a word boundary,
    with an ellipsis. A label with nothing after it is skipped."""
    if not isinstance(text, str):
        return ""
    line = ""
    for plain in (_plain(part) for part in text.splitlines()):
        if not plain:
            continue
        labelled = _TITLE_LABEL.fullmatch(plain)
        if labelled is None:
            line = plain
            break
        if clean_title(labelled.group(1)):
            return clean_title(labelled.group(1))
    if len(line) <= FALLBACK_MAX:
        return line
    cut = line[:FALLBACK_MAX]
    if line[FALLBACK_MAX] != " " and " " in cut:
        cut = cut[:cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "\u2026"


def delivery_id_from_request(request_id) -> "str | None":
    """The Winglet delivery id inside a Hermes admission request id, or None when it is not a hand-off id."""
    match = _REQUEST_ID.fullmatch(request_id) if isinstance(request_id, str) else None
    return match.group(1) if match else None


def read_receipt(profile: str, delivery_id: str):
    from tools.bot_live_delivery import read_delivery_result
    from .teamwork import _profile_home
    return read_delivery_result(_profile_home(profile), delivery_id)


class HandoffService:
    def __init__(self, hub):
        self.hub = hub
        self.read_receipt = read_receipt
        self._lock = asyncio.Lock()

    def _events(self, message):
        meta = message.get("meta") or {}
        key = (meta.get("asked") or meta.get("handoff_origin") or {}).get("delivery_id")
        if not isinstance(key, str):
            return []
        events = []
        for message_id in ("handoff-" + key, "handoff-target-" + key):
            row = self.hub.store.get_message(message_id)
            if row:
                events.extend([{"type": "message.update", "chat_id": row["chat_id"], "message": row},
                               {"type": "chat.update", "chat": self.hub.store.get_chat(row["chat_id"])}])
        return events

    async def begin(self, delivery_id, sender_title):
        return await self.hub.publish(
            lambda: self.hub.store.begin_handoff_notes(delivery_id, sender_title),
            lambda notes: [event for m in notes for event in (
                {"type": "message.new", "chat_id": m["chat_id"], "message": m},
                {"type": "chat.update", "chat": self.hub.store.get_chat(m["chat_id"])})])

    async def finish_inline(self, delivery_id, answer, failed=False):
        return await self.hub.publish(
            lambda: self.hub.store.finish_handoff(delivery_id, answer, failed, notify=False), self._events)

    async def finish_failed(self, delivery_id, reason):
        """Close a hand-off that never reached the teammate, and publish the notice."""
        return await self.hub.publish(
            lambda: self.hub.store.finish_handoff(delivery_id, reason, True), self._events)

    async def watch(self):
        while True:
            try:
                await self.sweep()
            except Exception:
                logger.warning('[winglet] hand-off notice sweep failed', exc_info=True)
            await asyncio.sleep(5)

    async def sweep(self):
        async with self._lock:
            for row in self.hub.store.pending_handoffs():
                try:
                    receipt = await asyncio.to_thread(self.read_receipt, row['to_bot'], row['delivery_id'])
                    if not isinstance(receipt, dict):
                        continue  # Missing is not failure: never resend or fabricate an outcome.
                    status = receipt.get('status')
                    if status not in ('settled', 'failed', 'cancelled', 'ambiguous'):
                        continue
                    reply = str(receipt.get('reply') or '').strip()
                    failed = status != 'settled' or not reply
                    answer = reply if not failed else 'The hand-off did not produce a confirmed answer. Do not resend automatically.'
                    message = await self.hub.publish(
                        lambda: self.hub.store.finish_handoff(row['delivery_id'], answer, failed),
                        self._events)
                    if message is not None and self.hub._notifiable(message):
                        # Generic message text; the answer is only in the expandable chat row.
                        # Existing mute/foreground/privacy rules handle this normal message push.
                        self.hub.schedule_push(message['chat_id'], message['id'], final=True)
                except Exception:
                    logger.debug('[winglet] hand-off outcome not readable yet', exc_info=True)
