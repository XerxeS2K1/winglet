import { cacheSet } from './cache';
import { useApp } from './store';
import type { InboxItem, Message } from './types';

const CACHED_MESSAGES = 200;
const CACHED_INBOX = 100;
/**
 * A chat that is streaming a reply changes ~30 times a second. Writing it every second means sealing up to 200 messages on
 * the JS thread each time, for text that is replaced a moment later. While a reply is still streaming, and nothing else in
 * the chat has changed, it is written at most this often. Anything else (an earlier message edited or deleted, a new message)
 * is written at the next one-second tick. So is the finished reply, so nothing final is lost; backgrounding, pagehide and
 * detaching write at once.
 */
export const STREAMING_WRITE_MS = 1000;

/**
 * Write chats, recent messages, the inbox and drafts to the on-device cache as they change, batched
 * once a second and immediately when the app leaves the foreground. Only server-confirmed messages
 * are cached; the outbox persists itself.
 */
export function attachPersistence(): () => void {
  let prev = useApp.getState();
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The last write of each chat: when, and the messages written (to see what changed since). Pruned when the chat goes. */
  const lastWrite = new Map<string, { at: number; list: Message[] }>();

  /** `onlyDue`: the once-a-second timer, which may hold back a chat that is still streaming. Everything else writes it all. */
  const flushNow = (onlyDue: boolean) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const state = useApp.getState();
    const now = Date.now();
    const held = new Set<string>();
    for (const key of dirty) {
      if (key === 'drafts') {
        cacheSet('drafts', state.drafts);
        continue;
      }
      if (key === 'draftFiles') {
        // Only finished uploads are worth keeping: the server holds them for a day.
        const ready = Object.fromEntries(Object.entries(state.draftFiles)
          .map(([k, files]) => [k, files.filter((f) => f.status === 'ready' && !f.autoSend)]).filter(([, files]) => files.length));
        cacheSet('draftFiles', ready);
        continue;
      }
      if (key === 'replyTo') {
        cacheSet('replyTo', state.replyTo);
        continue;
      }
      const [kind, serverId, chatId] = key.split('|');
      const rt = state.runtime[serverId];
      if (!rt) continue; // removed meanwhile; removeServer clears its cache
      if (kind === 'chats') cacheSet(`chats:${serverId}`, rt.chats);
      else if (kind === 'inbox') cacheSet(`inbox:${serverId}`, recentInbox(Object.values(rt.inbox)));
      else if (kind === 'msgs' && rt.messages[chatId] && (rt.chats[chatId] || !Object.keys(rt.chats).length)) {
        const list = rt.messages[chatId];
        const written = lastWrite.get(key);
        if (onlyDue && written && now - written.at < STREAMING_WRITE_MS && onlyTheStreamingReplyChanged(written.list, list)) {
          held.add(key);
          continue;
        }
        cacheSet(`msgs:${serverId}:${chatId}`, cacheable(list));
        lastWrite.set(key, { at: now, list: list.slice() });
      }
    }
    for (const key of lastWrite.keys()) { // chats that are gone (deleted, or their server removed) leave nothing behind
      const [, serverId, chatId] = key.split('|');
      if (!state.runtime[serverId]?.messages[chatId]) lastWrite.delete(key);
    }
    dirty.clear();
    for (const key of held) dirty.add(key);
    if (held.size) timer = setTimeout(timerFlush, 1000); // look again; they are written once due or once the reply ends
  };
  const flush = () => flushNow(false);
  const timerFlush = () => flushNow(true);

  const unsubscribe = useApp.subscribe((state) => {
    if (state.drafts !== prev.drafts) dirty.add('drafts');
    if (state.draftFiles !== prev.draftFiles) dirty.add('draftFiles');
    if (state.replyTo !== prev.replyTo) dirty.add('replyTo');
    for (const [serverId, rt] of Object.entries(state.runtime)) {
      const before = prev.runtime[serverId];
      if (!before || rt === before) continue;
      if (rt.chats !== before.chats) dirty.add(`chats|${serverId}`);
      if (rt.inbox !== before.inbox) dirty.add(`inbox|${serverId}`);
      if (rt.messages !== before.messages) {
        for (const [chatId, list] of Object.entries(rt.messages)) {
          if (list !== before.messages[chatId] && rt.loaded[chatId]) dirty.add(`msgs|${serverId}|${chatId}`);
        }
      }
    }
    const backgrounding = prev.foreground && !state.foreground;
    prev = state;
    if (backgrounding || (!state.foreground && dirty.size)) flush();
    else if (dirty.size && !timer) timer = setTimeout(timerFlush, 1000);
  });
  // pagehide also covers closing a browser tab before visibilitychange has reached the store.
  globalThis.addEventListener?.('pagehide', flush);
  return () => {
    unsubscribe();
    globalThis.removeEventListener?.('pagehide', flush);
    flush();
  };
}

/**
 * True when `now` differs from `written` only by the streaming reply at the end: the same last message, updated, or one new
 * last message. Every earlier message must be the very same object, and nothing may have been removed.
 */
function onlyTheStreamingReplyChanged(written: Message[], now: Message[]): boolean {
  const last = now.length - 1;
  if (last < 0 || now[last].status !== 'streaming') return false;
  if (written.length === now.length) {
    if (written[last].id !== now[last].id) return false;
  } else if (written.length !== last) return false;
  for (let i = 0; i < written.length && i < last; i++) if (written[i] !== now[i]) return false;
  return true;
}

export function cacheable(list: Message[]): Message[] {
  return list.filter((m) => m.status === 'final' || m.status === 'streaming').slice(-CACHED_MESSAGES);
}

function recentInbox(items: InboxItem[]): InboxItem[] {
  const pending = items.filter((i) => i.status === 'pending');
  const rest = items.filter((i) => i.status !== 'pending').sort((a, b) => b.created_at - a.created_at);
  return [...pending, ...rest].slice(0, Math.max(CACHED_INBOX, pending.length));
}
