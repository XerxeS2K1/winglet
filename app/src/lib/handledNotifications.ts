import type { InboxItem } from './types';

/** The tags the server puts on its notifications (plugin/hub.py): one per chat, one per inbox card. */
export const chatNoteTag = (chatId: string) => `chat-${chatId}`;
export const inboxNoteTag = (itemId: string) => `inbox-${itemId}`;

/** Cards that need an answer and no longer do (answered on another device, or expired): their alert has nothing left to say. */
export function handledNoteTags(items: Iterable<InboxItem>): string[] {
  const tags: string[] = [];
  for (const item of items) if (item.kind !== 'result' && item.status !== 'pending') tags.push(inboxNoteTag(item.id));
  return tags.slice(-200);
}
