/**
 * The durable replay checkpoint, split into the parts that actually changed.
 *
 * A checkpoint used to be one encrypted value holding every chat and every message for a bot, and it
 * was rewritten for each live journal event. Sealing megabytes on the JS thread stalled the phone for
 * ~1.5–2 s per event. One record per chat fixed that for the whole phone, but not for the chat you are
 * actually talking in: its record was still the chat's whole message array, so every new message
 * resealed all of it — 2.15 MB, 1.2–3.1 s per message, measured on the device at 74e5096.
 *
 * So a chat's messages are now an ordered list of chunks (about 64 KB of JSON each, or more for a very
 * long chat — see MAX_CHUNKS) and the meta record names that list. A save writes only the chunks whose
 * content changed, which for a new message is the tail chunk — tens of KB, tens of milliseconds — instead
 * of the whole history.
 *
 *   replay:<sid>              the pre-split whole-state record { cursor, state } — read once, then marked retired
 *   replay:<sid>:v2           { v: 2, cursor }  the v2 (whole-chat page) cursor — read for an upgrade, then removed
 *   replay:<sid>:meta         the v2 meta record — read for an upgrade, then removed
 *   replay:<sid>:m:<chat>     the v2 whole-chat page { messages, deleted } — read for an upgrade, then removed
 *   replay:<sid>:v3           { v: 3, cursor } — small, atomic, always written last
 *   replay:<sid>:v3:meta      the state below `v2:meta`, plus `chunks`: per chat, the ordered chunk keys
 *   replay:<sid>:c:<chat>:<i> { v: 3, messages } — chunk i of that chat, in order
 *   replay:<sid>:t:<chat>     { v: 3, deleted } — that chat's tombstones, written when the list changes or
 *                             the chat is re-fetched
 *
 * The store patches immutably, so a chat's message array gets a new identity only when it changed:
 * comparing that identity, and then each chunk, is what makes a save proportional to the change. Chunk
 * boundaries are computed from message sizes alone, so they never move when a message is appended; only
 * the tail chunk (or the chunk an edit landed in) is rewritten, and the walk itself stops at the tail.
 *
 * A save writes changed chunks and tombstones, then meta, then the cursor. A crash between them leaves
 * the cursor at or behind its data, which replay repairs; the other order is never written.
 */
import type { Chat, InboxItem, Me, Message, PauseState, ProjectSnapshot, TaskSnapshot } from '../../lib/types';

export type ReplayCursor = { epoch: string; scope: string; cursor: number };

/** Records bigger than this are sealed and a new one started: ~64 KB of JSON is tens of ms to encrypt. */
export const CHUNK_TARGET_BYTES = 64 * 1024;

/**
 * A chat is never cut into more chunks than this. Chunk count is what the meta record, the restore's
 * read fan-out and the number of records a save compares all pay for, so a chat that outgrows 256 chunks
 * of 64 KB raises its target instead of adding chunks: 100,000 messages become ~220 chunks of 256 KB,
 * not ~880 of 64 KB.
 *
 * The target is quantised to a power-of-two multiple of CHUNK_TARGET_BYTES, so an append cannot move it:
 * it changes only when a chat doubles its history, and that one save recuts the whole chat. Between
 * doublings the target is fixed, and the greedy cut of the messages before the tail depends on nothing
 * after it, so the boundaries of the closed chunks do not move and an append rewrites only the tail.
 */
export const MAX_CHUNKS = 256;

/** How many checkpoint records a restore reads (and decrypts) at once, whatever the chat count. */
export const READ_CONCURRENCY = 8;

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

/** One chat as it was last written: the array itself, its chunks, their marks, and the size they were cut at. */
export type SavedChat = { array: Message[]; keys: string[]; marks: ChunkMark[]; deleted: string[]; target: number };

/**
 * A restore's own chunk layout, exactly as the meta record names it: the keys in order and the message
 * count of each. Adopting it means the next save diffs against what the disk really holds, instead of
 * re-cutting the restored array and naming a different number of chunks.
 */
export type SavedLayout = Record<string, { keys: string[]; counts: number[] }>;

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
   * be adopted as "already saved": a truncated restore must be written again rather than trusted. A
   * missing tombstone record counts as incomplete, exactly as a malformed one does.
   */
  complete?: boolean;
  /** For a v3 restore: the chunk list and per-record message counts the meta named, for adoption. */
  layout?: SavedLayout;
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

/** The total serialised size of a chat's messages, from the memoised weights. */
function totalWeight(messages: Message[]): number {
  let total = 0;
  for (const message of messages) total += messageWeight(message);
  return total;
}

/**
 * The chunk size for a chat holding `total` bytes: CHUNK_TARGET_BYTES, doubled while that would take
 * more than MAX_CHUNKS chunks. Doubling rather than dividing keeps the answer one of a handful of values,
 * so the cut below changes only when a chat doubles its history — not on every message.
 */
function targetFor(total: number): number {
  let target = CHUNK_TARGET_BYTES;
  while (target * MAX_CHUNKS < total) target *= 2;
  return target;
}

/**
 * Cut a chat's messages into chunks of about `target`, never fewer than one message per chunk. The cut
 * depends only on the messages before it, so appending a message cannot move an earlier boundary and only
 * the tail chunk is rewritten. `from` continues a cut already closed before that index.
 */
function cutSizes(messages: Message[], target = CHUNK_TARGET_BYTES, from = 0): number[] {
  const sizes: number[] = [];
  let count = 0;
  let size = 0;
  for (let index = from; index < messages.length; index++) {
    const weight = messageWeight(messages[index]);
    if (count > 0 && size + weight > target) {
      sizes.push(count);
      count = 0; size = 0;
    }
    count += 1;
    size += weight;
  }
  if (count > 0) sizes.push(count);
  return sizes;
}

/** The mark of each chunk of `messages`, cut at the message counts in `sizes`, starting at `start`. */
function marksOf(messages: Message[], sizes: number[], start = 0): ChunkMark[] {
  const marks: ChunkMark[] = [];
  let from = start;
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

/** Whether the first `length` messages of `after` are the very objects `before` holds, in order. */
function samePrefix(before: Message[], after: Message[], length: number): boolean {
  for (let index = 0; index < length; index++) if (before[index] !== after[index]) return false;
  return true;
}

const countOf = (sizes: number[]) => sizes.reduce((n, size) => n + size, 0);

function chunkLayout(keys: CheckpointKeys, chatId: string, messages: Message[], before?: SavedChat) {
  const kept = before && countOf(before.marks.map((mark) => mark.n)) === messages.length
    ? before.marks.map((mark) => mark.n) : undefined;
  const target = before?.target ?? CHUNK_TARGET_BYTES;
  const layout = (sizes: number[], marks: ChunkMark[], size: number) =>
    ({ keys: sizes.map((_, index) => keys.chunk(chatId, index)), marks, target: size });

  // An edit replaces messages one for one, so the cuts a chat already had are kept: the chunk the edit
  // landed in is rewritten and the ones around it are not, even when the new text has a different length.
  if (kept) {
    const marks = marksOf(messages, kept);
    // A chunk that has grown past twice the target since its cut is cut again, so edits cannot bloat one.
    if (!marks.some((mark) => mark.w > target * 2)) return layout(kept, marks, target);
  }

  // An append cannot move a boundary that has already closed: every chunk but the last one is still cut
  // exactly where it was, so only the tail is walked and only the tail chunk can be rewritten. This is
  // what keeps a save proportional to what changed rather than to the length of the history.
  if (before && !kept && messages.length > countOf(before.marks.map((mark) => mark.n))
    && samePrefix(before.array, messages, countOf(before.marks.map((mark) => mark.n)))) {
    const closed = before.marks.slice(0, -1).map((mark) => mark.n);
    const from = countOf(closed);
    const tail = cutSizes(messages, target, from);
    const marks = [...before.marks.slice(0, -1), ...marksOf(messages, tail, from)];
    if (!marks.some((mark) => mark.w > target * 2)) return layout([...closed, ...tail], marks, target);
  }

  // A new chat, a shrink, a reorder or a target change: cut the whole chat at the size its history needs.
  const size = targetFor(totalWeight(messages));
  const sizes = cutSizes(messages, size);
  return layout(sizes, marksOf(messages, sizes), size);
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
 * array is the same object skip its layout entirely; `layout` lets a restore adopt the chunk list the
 * disk already names instead of re-cutting it.
 */
function walk(serverId: string, slices: CheckpointSlices, last?: SavedRefs, layout?: SavedLayout) {
  const keys = checkpointKeys(serverId);
  const ids = [...new Set([...Object.keys(slices.messages), ...Object.keys(slices.deleted)])];
  const chats: Record<string, SavedChat> = {};
  const chunks: Record<string, string[]> = {};
  for (const chatId of ids) {
    const array = slices.messages[chatId] ?? NO_MESSAGES;
    const deleted = slices.deleted[chatId] ?? NO_TOMBSTONES;
    const before = last?.chats[chatId];
    const fixed = layout?.[chatId];
    if (before && before.array === array) {
      chats[chatId] = { array, keys: before.keys, marks: before.marks, deleted, target: before.target };
    } else if (fixed && fixed.keys.length === fixed.counts.length && countOf(fixed.counts) === array.length) {
      // The layout the meta record names, marks and all: the next save compares against what is really
      // on the disk, so a kept (edit-era) cut is not silently re-cut into a different number of chunks.
      chats[chatId] = { array, keys: fixed.keys, marks: marksOf(array, fixed.counts), deleted,
        target: targetFor(totalWeight(array)) };
    } else {
      const cut = chunkLayout(keys, chatId, array, before);
      chats[chatId] = { array, keys: cut.keys, marks: cut.marks, deleted, target: cut.target };
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
    // The whole change detector is object identity, in two places: a chat whose array is the same object
    // holds the same messages, and a message object that is the same object is the same message — that,
    // and the samePrefix check in chunkLayout, is what decides which chunk records a save writes, and the
    // memoised weight and serial in this module assume it too.
    //
    // That is only sound because every store path REPLACES a message it changes rather than editing one
    // in place: upsertMessage (slice or map), setLocalStatus (map), markFailed (map), message.delete
    // (filter), mergeSnapshot (reuses a page only when nothing was removed), the outbox's localMessage
    // (a fresh object) and message.update (a new object from the server). An in-place edit would look
    // unchanged here and never reach the disk. tests/replayCheckpoint.test.ts drives each of those paths
    // and asserts that a message whose content changed is a new object, so the invariant is pinned.
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
 * next save then writes only what changed since, exactly as if it had written this state itself. The
 * restored layout (`meta.chunks` and each record's own message count) is the baseline, so a cut the disk
 * was left with — an edit-era one, say — is not replaced by a different number of chunks on the first save.
 */
export function savedRefsOf(serverId: string, slices: CheckpointSlices, layout?: SavedLayout): SavedRefs {
  const { chats, meta } = walk(serverId, slices, undefined, layout);
  return { chats, meta };
}

type CursorRecord = { v?: number; cursor?: ReplayCursor };

const validCursor = (cursor: ReplayCursor | undefined): cursor is ReplayCursor => !!cursor
  && typeof cursor.scope === 'string' && typeof cursor.epoch === 'string'
  && Number.isSafeInteger(cursor.cursor) && cursor.cursor >= 0;

/**
 * A bound on how many reads run at once. A 100,000-message chat is ~220 chunk records: issuing every one
 * of them together fans out that many decrypts on the JS thread, so a restore walks them in small batches.
 */
function bounded() {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= READ_CONCURRENCY) await new Promise<void>((release) => waiting.push(release));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * Read one chat's chunks, a bounded batch at a time, in order. A part that is missing or malformed is
 * skipped and noted, with the message count of each part that was readable so a restore can adopt the
 * layout exactly.
 */
async function readChunks(read: <T>(run: () => Promise<T>) => Promise<T>,
  get: <T>(key: string, fallback: T) => Promise<T>, keys: string[], named: string[],
  counts: number[]): Promise<{ messages: Message[]; complete: boolean }> {
  const messages: Message[] = [];
  let complete = true;
  for (const key of keys) {
    named.push(key);
    const part = await read(() => get<ChunkRecord | undefined>(key, undefined));
    if (!part || !Array.isArray(part.messages)) { complete = false; counts.push(0); continue; }
    counts.push(part.messages.length);
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
    /** The chunk list each chat was read from, so a save can diff against the disk's own layout. */
    const layout: SavedLayout = {};
    let complete = true;
    const read = bounded();
    await Promise.all([...ids].map(async (chatId) => {
      const chunks = Array.isArray(meta.chunks?.[chatId]) ? meta.chunks![chatId] : [];
      const counts: number[] = [];
      const parts = chunks.length
        ? await readChunks(read, get, chunks, named, counts)
        : { messages: NO_MESSAGES, complete: true };
      if (!parts.complete) complete = false;
      else if (chunks.length) layout[chatId] = { keys: chunks, counts };
      if (parts.messages.length) messages[chatId] = parts.messages;
      const record = await read(() => get<TombstoneRecord | undefined>(keys.tombstones(chatId), undefined));
      named.push(keys.tombstones(chatId));
      // A chat whose tombstone record is absent is as unfinished as one whose record is malformed: the
      // save that wrote the meta wrote a tombstone record for every chat, so a gap means the restore is
      // short and its deleted ids would be lost for good if this load were adopted as already saved.
      if (!record || !Array.isArray(record.deleted)) complete = false;
      else if (record.deleted.length) deleted[chatId] = record.deleted;
    }));
    const { v: _v, chunks: _chunks, ...rest } = meta;
    return { cursor: v3.cursor, state: { ...rest, messages, deleted }, keys: named, complete, layout };
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
