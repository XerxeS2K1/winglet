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
                        lambda m: [{'type': 'message.new', 'chat_id': m['chat_id'], 'message': m},
                                   {'type': 'chat.update', 'chat': self.hub.store.get_chat(m['chat_id'])}])
                    if message is not None:
                        # Generic message text; the answer is only in the expandable chat row.
                        # Existing mute/foreground/privacy rules handle this normal message push.
                        self.hub.schedule_push(message['chat_id'], message['id'], final=True)
                except Exception:
                    logger.debug('[winglet] hand-off outcome not readable yet', exc_info=True)
