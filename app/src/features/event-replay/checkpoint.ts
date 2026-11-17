/**
 * The durable replay checkpoint, split into the parts that actually changed.
 *
 * A checkpoint used to be one encrypted value holding every chat and every message for a bot, and it
 * was rewritten for each live journal event. Sealing megabytes on the JS thread stalled the phone for
 * ~1.5–2 s per event. One record per chat fixed that for the whole phone, but not for the chat you are
 * actually talking in: its record was still the chat's whole message array, so every new message
 * resealed all of it — 2.15 MB, 1.2–3.1 s per message, measured on the device at 74e5096.
 *
 * So a chat's messages are now an ordered list of chunks (about 64 KB of JSON each) and the meta record
 * names that list. A save writes only the chunks whose content changed, which for a new message is the
 * tail chunk — tens of KB, tens of milliseconds — instead of the whole history.
 *
 *   replay:<sid>              the pre-split whole-state record { cursor, state } — read once, then marked retired
 *   replay:<sid>:v2           { v: 2, cursor }  the v2 (whole-chat page) cursor — read for an upgrade, then removed
 *   replay:<sid>:meta         the v2 meta record — read for an upgrade, then removed
 *   replay:<sid>:m:<chat>     the v2 whole-chat page { messages, deleted } — read for an upgrade, then removed
 *   replay:<sid>:v3           { v: 3, cursor } — small, atomic, always written last
 *   replay:<sid>:v3:meta      the state below `v2:meta`, plus `chunks`: per chat, the ordered chunk keys
 *   replay:<sid>:c:<chat>:<i> { v: 3, messages } — chunk i of that chat, in order
 *   replay:<sid>:t:<chat>     { v: 3, deleted } — that chat's tombstones, written only when they change
 *
 * The store patches immutably, so a chat's message array gets a new identity only when it changed:
 * comparing that identity, and then each chunk, is what makes a save proportional to the change. Chunk
 * boundaries are computed from message sizes alone, so they never move when a message is appended; only
 * the tail chunk (or the chunk an edit landed in) is rewritten.
 *
 * A save writes changed chunks and tombstones, then meta, then the cursor. A crash between them leaves
 * the cursor at or behind its data, which replay repairs; the other order is never written.
 */
import type { Chat, InboxItem, Me, Message, PauseState, ProjectSnapshot, TaskSnapshot } from '../../lib/types';

export type ReplayCursor = { epoch: string; scope: string; cursor: number };

/** Records bigger than this are sealed and a new one started: ~64 KB of JSON is tens of ms to encrypt. */
export const CHUNK_TARGET_BYTES = 64 * 1024;

/** What one save persists besides the message chunks: everything else, plus the chunk index. */
export type MetaRecord = {
  v?: number;
  chats: Record<string, Chat>;
  loaded: Record<string, boolean>;
  inbox: Record<string, InboxItem>;
  pending: number;
  paused?: PauseState;
  me?: Me;
  projects?: ProjectSnapshot;
  tasks: Record<string, TaskSnapshot>;
  /** The chats whose records exist, so a restore knows what to read back. */
  pages?: string[];
  /** Per chat, the ordered chunk keys its messages live in: a restore concatenates them in order. */
  chunks?: Record<string, string[]>;
};

/** The v2 layout's one record per chat: read for an upgrade, never written again. */
export type ChatRecord = { messages: Message[]; deleted: string[] };
export type ChunkRecord = { v?: number; messages: Message[] };
export type TombstoneRecord = { v?: number; deleted: string[] };

/** The slices of a bot's runtime state a checkpoint covers. */
export type CheckpointSlices = MetaRecord & {
  messages: Record<string, Message[]>;
  deleted: Record<string, string[]>;
};

/**
 * The cheap description of one chunk this session saved: its message count, its JSON length, and a check
 * over the identity of every message in it. Messages are immutable objects, so a chunk whose check is
 * unchanged holds exactly the same messages; the check is what lets a save skip it without serialising it.
 */
export type ChunkMark = { n: number; w: number; h: number; f: number; l: number };

/** One chat as it was last written: the array itself, its chunks and their marks. */
export type SavedChat = { array: Message[]; keys: string[]; marks: ChunkMark[]; deleted: string[] };

/** The identities a successful save leaves on disk; the next save diffs against them. */
export type SavedRefs = { chats: Record<string, SavedChat>; meta: MetaRecord };

export type CheckpointPlan = {
  /** Strict writes in order: the data first, the cursor last. */
  write: { key: string; value: unknown }[];
  /** Exact keys of records a chat no longer owns, removed once the save above has committed. */
  prune: string[];
  /** The refs to remember once every write above has resolved. */
  saved: SavedRefs;
};

export type Checkpoint = {
  cursor: ReplayCursor;
  state: CheckpointSlices;
  /** Every data record this checkpoint occupies, so a sweep never deletes one of them. */
  keys?: string[];
  /** True when the state came from the v2 whole-chat layout, whose records are now scratch. */
  legacy?: boolean;
  /**
   * True when every record the meta named was read back and well formed. Only then may the loaded state
   * be adopted as "already saved": a truncated restore must be written again rather than trusted.
   */
  complete?: boolean;
};

export type CheckpointKeys = ReturnType<typeof checkpointKeys>;

export function checkpointKeys(serverId: string) {
  const base = `replay:${serverId}`;
  return {
    /** The pre-split record. Read for migration, marked retired after the first save that covers it. */
    base,
    /** v2: one record per chat. Read for an upgrade; removed once a v3 save covers it. */
    v2: { cursor: `${base}:v2`, meta: `${base}:meta`, chat: (chatId: string) => `${base}:m:${chatId}` },
    /** v3: chunked pages. The cursor record comes last, always. */
    cursor: `${base}:v3`,
    meta: `${base}:v3:meta`,
    chunkPrefix: `${base}:c:`,
    chunk: (chatId: string, index: number) => `${base}:c:${chatId}:${index}`,
    tombPrefix: `${base}:t:`,
    tombstones: (chatId: string) => `${base}:t:${chatId}`,
  };
}

const NO_MESSAGES: Message[] = [];
const NO_TOMBSTONES: string[] = [];

/**
 * A message's serialized length and a serial that stands for the object, memoised by identity. Messages
 * are never mutated in place, so one entry per message object is exact and is paid once per message —
 * which is what lets a save lay out a 5,000-message chat without serialising it.
 */
const weights = new WeakMap<object, number>();
const serials = new WeakMap<object, number>();
let serialSeq = 0;

function messageWeight(m: Message): number {
  let weight = weights.get(m);
  if (weight === undefined) {
    try { weight = JSON.stringify(m).length + 1; } catch { weight = 1; }
    weights.set(m, weight);
  }
  return weight;
}

function messageSerial(m: Message): number {
  let serial = serials.get(m);
  if (serial === undefined) {
    serial = ++serialSeq;
    serials.set(m, serial);
  }
  return serial;
}

/**
 * Cut a chat's messages into chunks of about CHUNK_TARGET_BYTES, never fewer than one message per chunk.
 * The cut depends only on the messages before it, so appending a message cannot move an earlier boundary
 * and only the tail chunk is rewritten.
 */
function cutSizes(messages: Message[]): number[] {
  const sizes: number[] = [];
  let count = 0;
  let size = 0;
  for (const message of messages) {
    const weight = messageWeight(message);
    if (count > 0 && size + weight > CHUNK_TARGET_BYTES) {
      sizes.push(count);
      count = 0; size = 0;
    }
    count += 1;
    size += weight;
  }
  if (count > 0) sizes.push(count);
  return sizes;
}

/** The mark of each chunk of `messages`, cut at the message counts in `sizes`. */
function marksOf(messages: Message[], sizes: number[]): ChunkMark[] {
  const marks: ChunkMark[] = [];
  let from = 0;
  for (const n of sizes) {
    let weight = 0;
    let hash = 0;
    let first = 0;
    let last = 0;
    for (let index = from; index < from + n; index++) {
      const message = messages[index];
      const serial = messageSerial(message);
      if (index === from) first = serial;
      last = serial;
      weight += messageWeight(message);
      hash = (Math.imul(hash, 31) + serial) | 0;
    }
    marks.push({ n, w: weight, h: hash, f: first, l: last });
    from += n;
  }
  return marks;
}

function chunkLayout(keys: CheckpointKeys, chatId: string, messages: Message[], before?: SavedChat) {
  // An edit replaces messages one for one, so the cuts a chat already had are kept: the chunk the edit
  // landed in is rewritten and the ones around it are not, even when the new text has a different length.
  const kept = before && before.marks.reduce((n, mark) => n + mark.n, 0) === messages.length
    ? before.marks.map((mark) => mark.n) : undefined;
  let sizes = kept;
  let marks = sizes ? marksOf(messages, sizes) : undefined;
  // A chunk that has grown past twice the target since its cut is cut again, so edits cannot bloat one.
  if (!marks || marks.some((mark) => mark.w > CHUNK_TARGET_BYTES * 2)) {
    sizes = cutSizes(messages);
    marks = marksOf(messages, sizes);
  }
  return { keys: sizes!.map((_, index) => keys.chunk(chatId, index)), marks: marks! };
}

const sameMark = (a: ChunkMark, b: ChunkMark) => a.n === b.n && a.w === b.w && a.h === b.h && a.f === b.f && a.l === b.l;

const sameList = (a: string[] | undefined, b: string[] | undefined) => !!a && !!b
  && a.length === b.length && a.every((value, i) => value === b[i]);

const sameChunks = (a: Record<string, string[]> | undefined, b: Record<string, string[]> | undefined) => {
  if (!a || !b) return false;
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  return ids.every((id) => sameList(a[id], b[id]));
};

const sameMeta = (a: MetaRecord, b: MetaRecord | undefined) => !!b
  && a.v === b.v
  && a.chats === b.chats && a.loaded === b.loaded && a.inbox === b.inbox && a.pending === b.pending
  && a.paused === b.paused && a.me === b.me && a.projects === b.projects && a.tasks === b.tasks
  && sameList(a.pages, b.pages) && sameChunks(a.chunks, b.chunks);

/**
 * Describe what a save of these slices would leave on disk, without copying or serialising anything: the
 * per-chat chunk keys and marks, and the meta record that names them. `last` lets a chat whose message
 * array is the same object skip its layout entirely.
 */
function walk(serverId: string, slices: CheckpointSlices, last?: SavedRefs) {
  const keys = checkpointKeys(serverId);
  const ids = [...new Set([...Object.keys(slices.messages), ...Object.keys(slices.deleted)])];
  const chats: Record<string, SavedChat> = {};
  const chunks: Record<string, string[]> = {};
  for (const chatId of ids) {
    const array = slices.messages[chatId] ?? NO_MESSAGES;
    const deleted = slices.deleted[chatId] ?? NO_TOMBSTONES;
    const before = last?.chats[chatId];
    if (before && before.array === array) {
      chats[chatId] = { array, keys: before.keys, marks: before.marks, deleted };
    } else {
      const layout = chunkLayout(keys, chatId, array, before);
      chats[chatId] = { array, keys: layout.keys, marks: layout.marks, deleted };
    }
    chunks[chatId] = chats[chatId].keys;
  }
  const meta: MetaRecord = {
    v: 3,
    chats: slices.chats, loaded: slices.loaded, inbox: slices.inbox, pending: slices.pending,
    paused: slices.paused, me: slices.me, projects: slices.projects, tasks: slices.tasks,
    pages: ids, chunks,
  };
  return { ids, chats, meta };
}

/**
 * Decide what this save must write. Reads refs only — no copying, no stringify — so it is safe to call
 * synchronously before the first await, which is what makes the recorded refs exactly the ones that were
 * persisted.
 */
export function planCheckpoint(serverId: string, slices: CheckpointSlices, cursor: ReplayCursor,
  last?: SavedRefs): CheckpointPlan {
  const keys = checkpointKeys(serverId);
  const { ids, chats, meta } = walk(serverId, slices, last);
  const write: { key: string; value: unknown }[] = [];
  const prune: string[] = [];
  for (const chatId of ids) {
    const saved = chats[chatId];
    const before = last?.chats[chatId];
    const messages = slices.messages[chatId] ?? NO_MESSAGES;
    if (!before || before.array !== messages) {
      // A new array: rewrite exactly the chunks whose content is not what is already on the disk.
      let from = 0;
      for (let index = 0; index < saved.keys.length; index++) {
        const mark = saved.marks[index];
        const previous = before?.marks[index];
        const unchanged = !!previous && before.keys[index] === saved.keys[index] && sameMark(previous, mark);
        if (!unchanged) {
          write.push({ key: saved.keys[index], value: { v: 3, messages: messages.slice(from, from + mark.n) } });
        }
        from += mark.n;
      }
      // A shorter array (a delete, a resync) leaves chunks past its end that nothing names any more.
      const owned = before?.keys.length ?? 0;
      for (let index = saved.keys.length; index < owned; index++) prune.push(before!.keys[index]);
    }
    // Tombstones are small and change on their own, so they are their own record.
    if (!before || before.deleted !== saved.deleted) {
      write.push({ key: keys.tombstones(chatId), value: { v: 3, deleted: saved.deleted } });
    }
  }
  // A chat that is gone keeps every record it owned until this save has committed.
  for (const chatId of Object.keys(last?.chats ?? {})) {
    if (ids.includes(chatId)) continue;
    prune.push(...(last?.chats[chatId]?.keys ?? []), keys.tombstones(chatId));
  }
  // Meta names the chunk records, so it is rewritten when a slice or the index itself changed.
  if (!sameMeta(meta, last?.meta)) write.push({ key: keys.meta, value: meta });
  // The cursor goes last, always: a value on disk may be ahead of the cursor, never behind it.
  write.push({ key: keys.cursor, value: { v: 3, cursor } });
  return { write, prune, saved: { chats, meta } };
}

/**
 * The refs that describe state which is already on disk, for a load that restored a v3 checkpoint: the
 * next save then writes only what changed since, exactly as if it had written this state itself.
 */
export function savedRefsOf(serverId: string, slices: CheckpointSlices): SavedRefs {
  const { chats, meta } = walk(serverId, slices);
  return { chats, meta };
}

type CursorRecord = { v?: number; cursor?: ReplayCursor };

const validCursor = (cursor: ReplayCursor | undefined): cursor is ReplayCursor => !!cursor
  && typeof cursor.scope === 'string' && typeof cursor.epoch === 'string'
  && Number.isSafeInteger(cursor.cursor) && cursor.cursor >= 0;

/** Read one chat's chunks in order. A part that is missing or malformed is skipped, and noted. */
async function readChunks(get: <T>(key: string, fallback: T) => Promise<T>, keys: string[],
  named: string[]): Promise<{ messages: Message[]; complete: boolean }> {
  const parts = await Promise.all(keys.map((key) => get<ChunkRecord | undefined>(key, undefined)));
  const messages: Message[] = [];
  let complete = true;
  for (let index = 0; index < keys.length; index++) {
    named.push(keys[index]);
    const part = parts[index];
    if (!part || !Array.isArray(part.messages)) { complete = false; continue; }
    for (const message of part.messages) messages.push(message);
  }
  return { messages, complete };
}

/**
 * Read a checkpoint back, newest layout first: the v3 chunked records when a v3 cursor exists, else the
 * v2 whole-chat records an older build wrote, else the pre-split record. The chat ids the meta names
 * drive the reads, so a record left behind by a chat that no longer exists is simply ignored.
 */
export async function loadCheckpoint(serverId: string,
  get: <T>(key: string, fallback: T) => Promise<T>): Promise<Checkpoint | undefined> {
  const keys = checkpointKeys(serverId);
  const v3 = await get<CursorRecord | undefined>(keys.cursor, undefined);
  if (v3?.v === 3 && validCursor(v3.cursor)) {
    const meta = await get<MetaRecord | undefined>(keys.meta, undefined);
    if (!meta || typeof meta.chats !== 'object') return undefined;
    const ids = new Set(Array.isArray(meta.pages) ? meta.pages
      : [...Object.keys(meta.chats), ...Object.keys(meta.loaded ?? {})]);
    const named: string[] = [];
    const messages: Record<string, Message[]> = {};
    const deleted: Record<string, string[]> = {};
    let complete = true;
    await Promise.all([...ids].map(async (chatId) => {
      const chunks = Array.isArray(meta.chunks?.[chatId]) ? meta.chunks![chatId] : [];
      const parts = chunks.length ? await readChunks(get, chunks, named) : { messages: NO_MESSAGES, complete: true };
      if (!parts.complete) complete = false;
      if (parts.messages.length) messages[chatId] = parts.messages;
      const record = await get<TombstoneRecord | undefined>(keys.tombstones(chatId), undefined);
      named.push(keys.tombstones(chatId));
      if (record && !Array.isArray(record.deleted)) complete = false;
      if (record && Array.isArray(record.deleted) && record.deleted.length) deleted[chatId] = record.deleted;
    }));
    const { v: _v, chunks: _chunks, ...rest } = meta;
    return { cursor: v3.cursor, state: { ...rest, messages, deleted }, keys: named, complete };
  }
  const v2 = await get<CursorRecord | undefined>(keys.v2.cursor, undefined);
  if (v2?.v === 2 && validCursor(v2.cursor)) {
    const meta = await get<MetaRecord | undefined>(keys.v2.meta, undefined);
    if (!meta || typeof meta.chats !== 'object') return undefined;
    const ids = new Set(Array.isArray(meta.pages) ? meta.pages
      : [...Object.keys(meta.chats), ...Object.keys(meta.loaded ?? {})]);
    const named: string[] = [keys.v2.cursor, keys.v2.meta];
    const records = await Promise.all([...ids].map(async (chatId) => {
      const key = keys.v2.chat(chatId);
      named.push(key);
      return get<ChatRecord | undefined>(key, undefined);
    }));
    const messages: Record<string, Message[]> = {};
    const deleted: Record<string, string[]> = {};
    let complete = true;
    let index = 0;
    for (const chatId of ids) {
      const record = records[index++];
      if (!record || !Array.isArray(record.messages) || !Array.isArray(record.deleted)) { complete = false; continue; }
      if (record.messages.length) messages[chatId] = record.messages;
      if (record.deleted.length) deleted[chatId] = record.deleted;
    }
    const { v: _v, chunks: _chunks, ...rest } = meta;
    return { cursor: v2.cursor, state: { ...rest, messages, deleted }, keys: named, legacy: true, complete };
  }
  const legacy = await get<Checkpoint | undefined>(keys.base, undefined);
  return legacy?.cursor && legacy.state ? legacy : undefined;
}
