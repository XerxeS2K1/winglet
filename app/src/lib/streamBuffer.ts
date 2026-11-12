import type { Message } from './types';

/** About one frame at 30 fps. A streaming chat is written to the store at most this often. */
export const FRAME_MS = 33;

/**
 * An update that may wait for the next frame: a bot reply that is still streaming. Everything else (a finished, errored or
 * aborted reply, a message from anyone else, a new message, any other kind of event) is applied at once, and first
 * applies whatever is waiting, so nothing is ever reordered.
 */
export function canCoalesce(ev: any): boolean {
  return ev?.type === 'message.update' && typeof ev.chat_id === 'string'
    && ev.message?.role === 'bot' && ev.message?.status === 'streaming';
}

export type StreamTimers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };

/**
 * Holds back streamed updates so a chat is written to the store at most once per frame, however fast the tokens arrive.
 *
 * The first update after a quiet moment is applied at once (the first words appear without delay) and opens a frame. Updates
 * that arrive while the frame is open wait; only the newest of a message is kept, because each update carries the whole
 * message. When the frame ends the waiting updates are applied and, if there were any, a new frame opens.
 *
 * `flush()` applies everything waiting, now. Callers must call it before applying anything else to the same state, and
 * when the connection drops, the app goes to the background or the chat on screen changes.
 */
export function createStreamBuffer(apply: (serverId: string, chatId: string, message: Message) => void, timers: StreamTimers) {
  const waiting = new Map<string, { serverId: string; chatId: string; message: Message }>();
  let frame: unknown;
  let open = false;

  const endFrame = () => {
    frame = undefined;
    open = false;
    if (flush()) startFrame();
  };
  const startFrame = () => {
    open = true;
    frame = timers.set(endFrame, FRAME_MS);
  };

  /** Apply everything waiting, oldest first. Returns whether there was anything. */
  function flush(): boolean {
    if (frame !== undefined) { timers.clear(frame); frame = undefined; open = false; }
    if (!waiting.size) return false;
    const items = [...waiting.values()];
    waiting.clear();
    for (const item of items) apply(item.serverId, item.chatId, item.message);
    return true;
  }

  function add(serverId: string, chatId: string, message: Message) {
    const key = `${serverId}\u0000${chatId}`;
    const held = waiting.get(key);
    if (held && held.message.id !== message.id) {
      // Another message in the same chat: the older one goes first.
      waiting.delete(key);
      apply(held.serverId, held.chatId, held.message);
    } else if (held && message.updated_at < held.message.updated_at) {
      return; // an older update than the one already waiting: the store would have ignored it too
    }
    if (!open) {
      startFrame();
      apply(serverId, chatId, message);
      return;
    }
    waiting.set(key, { serverId, chatId, message });
  }

  return { add, flush, pending: () => waiting.size };
}
