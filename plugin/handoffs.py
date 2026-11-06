"""Durable, human-only completion notices for Winglet hand-offs. Never resend or wake an agent."""
from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


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
