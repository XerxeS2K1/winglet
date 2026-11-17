/**
 * The durable replay checkpoint, split into the parts that actually changed.
 *
 * A checkpoint used to be one encrypted value holding every chat and every message for a bot, and it
 * was rewritten for each live journal event. Sealing megabytes on the JS thread stalled the phone for
 * ~1.5–2 s per event. None of that value had to be whole: a save only has to make sure the data its
 * cursor covers is on disk *before* the cursor itself is.
 *
 * So the checkpoint is now:
 *
 *   replay:<sid>          the old whole-state record { cursor, state } — read once, then removed
 *   replay:<sid>:v2       { v: 2, cursor } — small, atomic, always written last
 *   replay:<sid>:meta     chats, loaded, inbox, pending, paused, me, projects, tasks
 *   replay:<sid>:m:<chat> { messages, deleted } for that one chat
 *
 * The store patches immutably, so a slice or a chat's message array gets a new identity only when it
 * changed: comparing against the last saved refs is what makes a save proportional to the change.
 *
 * A save writes dirty chat records, then meta, then the cursor. A crash between them leaves the
 * cursor at or behind its data, which replay repairs; the other order is never written.
 */
import type { Chat, InboxItem, Me, Message, PauseState, ProjectSnapshot, TaskSnapshot } from '../../lib/types';

export type ReplayCursor = { epoch: string; scope: string; cursor: number };

/** What one save persists besides the cursor: everything but the message pages. */
export type MetaRecord = {
  chats: Record<string, Chat>;
  loaded: Record<string, boolean>;
  inbox: Record<string, InboxItem>;
  pending: number;
  paused?: PauseState;
  me?: Me;
  projects?: ProjectSnapshot;
  tasks: Record<string, TaskSnapshot>;
  /** The chats whose page record exists, so a restore knows what to read back. */
  pages?: string[];
};

/** One chat's page and its tombstones: rewritten only when that chat changed. */
export type ChatRecord = { messages: Message[]; deleted: string[] };

/** The slices of a bot's runtime state a checkpoint covers. */
export type CheckpointSlices = MetaRecord & {
  messages: Record<string, Message[]>;
  deleted: Record<string, string[]>;
};

/** The identities a successful save leaves on disk; the next save diffs against them. */
export type SavedRefs = {
  chats: Record<string, ChatRecord>;
  meta: MetaRecord;
  /** The chat ids whose page record was written, so a change in the set rewrites meta. */
  ids: string[];
};

export type CheckpointPlan = {
  /** Strict writes in order: the data first, the cursor last. */
  write: { key: string; value: unknown }[];
  /** The refs to remember once every write above has resolved. */
  saved: SavedRefs;
};

export type Checkpoint = { cursor: ReplayCursor; state: CheckpointSlices };

const NO_MESSAGES: Message[] = [];
const NO_TOMBSTONES: string[] = [];

export function checkpointKeys(serverId: string) {
  const base = `replay:${serverId}`;
  return {
    /** The pre-split record. Read for migration, removed after the first v2 save. */
    base,
    cursor: `${base}:v2`,
    meta: `${base}:meta`,
    chat: (chatId: string) => `${base}:m:${chatId}`,
  };
}

const sameMeta = (a: MetaRecord, b: MetaRecord | undefined) => !!b
  && a.chats === b.chats && a.loaded === b.loaded && a.inbox === b.inbox && a.pending === b.pending
  && a.paused === b.paused && a.me === b.me && a.projects === b.projects && a.tasks === b.tasks;

/**
 * Decide what this save must write. Reads refs only — no copying, no stringify — so it is safe to
 * call synchronously before the first await, which is what makes the recorded refs exactly the ones
 * that were persisted.
 */
export function planCheckpoint(serverId: string, slices: CheckpointSlices, cursor: ReplayCursor,
  last?: SavedRefs): CheckpointPlan {
  const keys = checkpointKeys(serverId);
  const ids = new Set<string>([...Object.keys(slices.messages), ...Object.keys(slices.deleted)]);
  const write: { key: string; value: unknown }[] = [];
  const chats: Record<string, ChatRecord> = {};
  for (const chatId of ids) {
    const record: ChatRecord = {
      messages: slices.messages[chatId] ?? NO_MESSAGES,
      deleted: slices.deleted[chatId] ?? NO_TOMBSTONES,
    };
    chats[chatId] = record;
    const before = last?.chats[chatId];
    if (!before || before.messages !== record.messages || before.deleted !== record.deleted) {
      write.push({ key: keys.chat(chatId), value: record });
    }
  }
  const meta: MetaRecord = {
    chats: slices.chats, loaded: slices.loaded, inbox: slices.inbox, pending: slices.pending,
    paused: slices.paused, me: slices.me, projects: slices.projects, tasks: slices.tasks,
    pages: [...ids],
  };
  // Meta names the page records, so it must be rewritten when the set of them changes too.
  if (!sameMeta(meta, last?.meta) || !last || last.ids.join() !== [...ids].join()) write.push({ key: keys.meta, value: meta });
  // The cursor goes last, always: a value on disk may be ahead of the cursor, never behind it.
  write.push({ key: keys.cursor, value: { v: 2, cursor } });
  return { write, saved: { chats, meta, ids: [...ids] } };
}

/**
 * Read a checkpoint back. The chats the meta record names drive the message reads, so a record left
 * behind by a chat that no longer exists is simply ignored. Falls back to the pre-split record so an
 * upgrade keeps the history the phone already had.
 */
export async function loadCheckpoint(serverId: string,
  get: <T>(key: string, fallback: T) => Promise<T>): Promise<Checkpoint | undefined> {
  const keys = checkpointKeys(serverId);
  const cursorRecord = await get<{ v?: number; cursor?: ReplayCursor } | undefined>(keys.cursor, undefined);
  const cursor = cursorRecord?.v === 2 ? cursorRecord.cursor : undefined;
  if (!cursor || typeof cursor.scope !== 'string' || typeof cursor.epoch !== 'string'
    || !Number.isSafeInteger(cursor.cursor) || cursor.cursor < 0) {
    const legacy = await get<Checkpoint | undefined>(keys.base, undefined);
    return legacy?.cursor && legacy.state ? legacy : undefined;
  }
  const meta = await get<MetaRecord | undefined>(keys.meta, undefined);
  if (!meta || typeof meta.chats !== 'object') return undefined;
  const ids = new Set(Array.isArray(meta.pages) ? meta.pages
    : [...Object.keys(meta.chats), ...Object.keys(meta.loaded ?? {})]);
  const messages: Record<string, Message[]> = {};
  const deleted: Record<string, string[]> = {};
  await Promise.all([...ids].map(async (chatId) => {
    const record = await get<ChatRecord | undefined>(keys.chat(chatId), undefined);
    if (!record) return;
    if (Array.isArray(record.messages) && record.messages.length) messages[chatId] = record.messages;
    if (Array.isArray(record.deleted) && record.deleted.length) deleted[chatId] = record.deleted;
  }));
  return { cursor, state: { ...meta, messages, deleted } };
}
