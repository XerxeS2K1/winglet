import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

/**
 * The replay checkpoint is written in parts: one record per chat that changed, one for the rest of the
 * state, and a small cursor record last. These tests pin the properties that make that safe — the
 * cursor never runs ahead of its data, a save costs what changed rather than the whole phone, a burst
 * costs one save, and re-applying events from a coarser cursor changes nothing.
 */

class ApiError extends Error {
  status: number;
  data?: any;
  constructor(message: string, status: number, data?: any) { super(message); this.status = status; this.data = data; }
}

type Write = { key: string; bytes: number; value: any };

const msg = (n: number, over: any = {}) => ({ id: `m${n}`, position: n, chat_id: 'general', role: 'bot',
  text: String(n), status: 'final', meta: {}, created_at: 1, updated_at: n, ...over });

const chat = (id: string) => ({ id, kind: 'chat', title: id });

const inboxItem = (id: string, over: any = {}) => ({ id, kind: 'task', status: 'pending',
  title: `item ${id}`, body: 'body', created_at: 1, ...over });

/** A history big enough that the old whole-state checkpoint is megabytes. */
function seed(nChats: number, nMessages: number, textLen: number) {
  const chats: Record<string, any> = {};
  const messages: Record<string, any[]> = {};
  for (let c = 0; c < nChats; c++) {
    const id = c === 0 ? 'general' : `chat${c}`;
    chats[id] = chat(id);
    messages[id] = Array.from({ length: nMessages }, (_, i) => ({
      id: `${id}-${i}`, position: i, chat_id: id, role: 'bot', text: 'x'.repeat(textLen),
      status: 'final', meta: {}, created_at: 1, updated_at: i + 1,
    }));
  }
  return { chats, messages };
}

const checkpointState = (history: { chats: any; messages: any }) => ({
  chats: history.chats, messages: history.messages, deleted: {}, loaded: {}, inbox: {}, pending: 0, tasks: {},
});

function harness(shared?: Map<string, any>) {
  let request: (...args: any[]) => Promise<any> = async () => ({
    items: [], pending: 0, messages: [], deleted_ids: [], pet: null, projects: undefined,
  });
  let persisted: any;
  let socket: any;
  const sockets: any[] = [];
  /** Closes that must throw, as a wedged socket does. */
  let brokenCloses = 0;
  const flushCalls: string[] = [];
  /** Timers the store itself scheduled (the save chain's bound), runnable on demand. */
  const storeTimers: Array<{ fn?: () => void; ms: number } | undefined> = [];
  /** Timers the session scheduled (its resume timeout), runnable on demand. */
  const sessionTimers: Array<{ fn?: () => void; ms: number } | undefined> = [];
  const frames: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const played: string[] = [];
  const cache = shared ?? new Map<string, any>();
  const writes: Write[] = [];
  const failOn = new Set<string>();
  /** Deletes that fail, kept apart from writes so a prune can fail while the save that owns the key succeeds. */
  const failDeleteOn = new Set<string>();
  /** Keys whose next write waits for the test to release it: a save held in flight. */
  const gates = new Map<string, Promise<void>>();
  class FakeSocket {
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    constructor() { socket = this; sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { if (brokenCloses > 0) { brokenCloses--; throw new Error('socket close failed'); } }
    event(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  class FakeCoordinator {
    members = new Map<string, any>();
    join(id: string, m: any) { this.members.set(id, m); }
    leave(id: string) { this.members.delete(id); }
    async want() {}
    satisfied() {}
    setForeground() {}
    setOnline() {}
    retryNow() {}
  }
  /** A clock per side: a test can run the store's timers without firing the session's, and back. */
  function clock(sink: Array<{ fn?: () => void; ms: number } | undefined>) {
    return {
      setTimeout: (fn: () => void, ms?: number) => { sink.push({ fn, ms: ms ?? 0 }); return sink.length - 1; },
      clearTimeout: (id: number) => { if (typeof id === 'number') sink[id] = undefined; },
    };
  }
  function compile(file: string, imports: Record<string, any>) {
    const exports: any = {};
    const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      exports, require: (id: string) => {
        if (id in imports) return imports[id];
        throw new Error(`Unexpected import ${id}`);
      },
      WebSocket: FakeSocket,
      ...clock(file.includes('store.ts') ? storeTimers : sessionTimers),
      setInterval: () => 0, clearInterval: () => {},
    });
    return exports;
  }
  const helpers = compile('../src/lib/messages.ts', {});
  const streamModule = compile('../src/lib/streamBuffer.ts', {});
  const streamBuffer = { ...streamModule, createStreamBuffer: (apply: any) => streamModule.createStreamBuffer(apply, {
    set: (fn: () => void, ms: number) => { frames.push({ fn, ms, live: true }); return frames.length - 1; },
    clear: (id: number) => { if (frames[id]) frames[id].live = false; },
  }) };
  const replayProtocol = compile('../src/features/event-replay/protocol.ts', {});
  const replaySession = compile('../src/features/event-replay/session.ts', { './protocol': replayProtocol });
  // The store's own end-of-life boundaries drop a connection; only a flush can persist what it still
  // holds, so the store's path is counted here rather than assumed.
  const sessionSpy = {
    ...replaySession,
    SyncSession: class extends (replaySession as any).SyncSession {
      flush() { flushCalls.push('flush'); return super.flush(); }
    },
  };
  const checkpoint = compile('../src/features/event-replay/checkpoint.ts', {});
  /** The merge the store's resync applies, driven directly by the invariant test. */
  const mergeModule = compile('../src/features/event-replay/merge.ts', {});
  const { useApp: store } = compile('../src/lib/store.ts', {
    zustand: { create: (fn: any) => createStore(fn) },
    'zustand/react/shallow': { useShallow: (fn: any) => fn },
    'react-native': { Platform: { OS: 'android' } },
    './recovery': { RecoveryCoordinator: FakeCoordinator },
    '../features/phone-tools/runtime': { phoneHello() {}, phoneEvent() {}, phoneDisconnect() {}, phoneVisibility() {} },
    './messages': helpers,
    './streamBuffer': streamBuffer,
    './commands': { needsSignature: () => false },
    '../features/projects/logic': compile('../src/features/projects/logic.ts', {}),
    '../features/event-replay/session': sessionSpy,
    '../features/event-replay/merge': mergeModule,
    '../features/event-replay/checkpoint': checkpoint,
    './api': { api: (...args: any[]) => request(...args), ApiError, wsUrl: (s: any) => s.url,
      signedApi: (...args: any[]) => request(...args) },
    './cache': {
      cacheGet: async (key: string, fallback: any) => (cache.has(key) ? structuredClone(cache.get(key)) : fallback),
      cacheSetStrict: async (key: string, value: any) => {
        if (failOn.has(key)) throw new Error(`storage full: ${key}`);
        const gate = gates.get(key);
        if (gate) { gates.delete(key); await gate; }
        writes.push({ key, bytes: JSON.stringify(value).length, value: structuredClone(value) });
        cache.set(key, structuredClone(value));
      },
      cacheSet: async (key: string, value: any) => { cache.set(key, structuredClone(value)); },
      cacheRemove: async (prefix: string) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); },
      /** Exact, like the real one: a chat id must not take a longer id that starts with it. */
      cacheDeleteStrict: async (key: string) => {
        if (failOn.has(key) || failDeleteOn.has(key)) throw new Error(`storage full: ${key}`);
        cache.delete(key);
      },
      cacheKeys: async (prefix: string) => [...cache.keys()].filter((k) => k.startsWith(prefix)),
    },
    './verify': { NEEDS_VERIFY: 'Verify this phone to do that.' },
    './network': { refreshNetworkNow: async () => {} },
    './authCheck': { ...compile('../src/lib/authCheck.ts', {}), AUTH_RECHECK_DELAYS_MS: [1, 1], pause: async () => {} },
    './handledNotifications': compile('../src/lib/handledNotifications.ts', {}),
    './perf': { PERF_ON: false },
    '../features/encrypted-push/native': { pushNative: { clear() {} } },
    '../features/execution/model': compile('../src/features/execution/model.ts', {}),
    './sounds': { sound: { reply: () => played.push('reply'), needsYou: () => played.push('needsYou'), tap() {}, sent() {} } },
    './storage': { getJSON: async (key: string, fallback: any) => (key === 'winglet.servers' && persisted) || fallback,
      setJSON: async (key: string, value: any) => { if (key === 'winglet.servers') persisted = value; } },
  });
  const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return {
    store, cache, writes, failOn, failDeleteOn, played, checkpoint, merge: mergeModule, tick, flushCalls,
    socket: () => socket,
    /** Every socket opened, oldest first: a replacement is the last one. */
    sockets: () => sockets,
    /** Make the next n socket closes throw, as a wedged socket does. */
    failCloses: (n: number) => { brokenCloses = n; },
    /** Run the timers the store itself scheduled (its save chain's bound). */
    runStoreTimers: () => { for (const timer of storeTimers.splice(0)) timer?.fn?.(); },
    /** The delays of the store's pending timers, so a bound's magnitude can be pinned. */
    storeTimerDelays: () => storeTimers.filter((timer) => timer !== undefined).map((timer) => timer!.ms),
    /** Run the timers the session scheduled (its resume timeout). */
    runSessionTimers: () => { for (const timer of sessionTimers.splice(0)) timer?.fn?.(); },
    /** Every cursor value a save actually put on disk, in order. */
    cursorWrites: () => writes.filter((w) => w.key === 'replay:s:v3').map((w) => w.value.cursor.cursor),
    event: (data: any) => socket.event(data),
    /** Make the next write of this key wait; the returned call releases it. A save held in flight. */
    hold: (key: string) => {
      let release!: () => void;
      gates.set(key, new Promise<void>((resolve) => { release = resolve; }));
      return () => release();
    },
    setRequest: (fn: typeof request) => { request = fn; },
    reset: () => { writes.length = 0; },
    /** Bytes written since the last reset, and the keys in order. */
    keys: () => writes.map((w) => w.key),
    bytes: () => writes.reduce((n, w) => n + w.bytes, 0),
    /** Start a server whose journal this phone may resume from; the reply is supplied by the test. */
    async begin(watermark = 0) {
      store.getState().setVisibleChat({ serverId: 's', chatId: 'general' });
      this.event({ type: 'hello', chats: [chat('general')], pending: 0, features: { event_replay: true },
        event_stream: { scope: 'scope', epoch: 'epoch', watermark } });
      await tick();
    },
    /** One page of the journal, as the server answers a resume. */
    async reply(watermark: number, cursor: number, events: any[] = []) {
      this.event({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark, cursor, has_more: false, events });
      await tick();
    },
    async join(watermark = 0) {
      await this.begin(watermark);
      await this.reply(watermark, watermark);
    },
    async connect(history?: { chats: any; messages: any }) {
      if (history) {
        cache.set('replay:s', { cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 }, state: checkpointState(history) });
      }
      await store.getState().addServer({ id: 's', url: 'http://test', token: 'test', deviceId: 'dev', bot: { title: 'Test' } });
      await store.getState().init();
      await tick();
    },
    messages: (id = 'general') => store.getState().runtime.s.messages[id] ?? [],
    phase: () => store.getState().runtime.s.sync?.phase,
  };
}

/** The whole-state payload the old checkpoint wrote, for comparison. */
const wholeStateBytes = (h: any) => {
  const rt = h.store.getState().runtime.s;
  return JSON.stringify({ cursor: {}, state: { chats: rt.chats, messages: rt.messages, deleted: rt.deleted,
    loaded: rt.loaded, inbox: rt.inbox, pending: rt.pending, paused: rt.paused, me: rt.me,
    projects: rt.projects, tasks: rt.tasks } }).length;
};

/** The chunk keys the meta record names for one chat, in order. */
const chunkKeys = (h: any, chatId = 'general'): string[] =>
  h.cache.get('replay:s:v3:meta')?.chunks?.[chatId] ?? [];

/** The messages a restore would read back for one chat: every named chunk, concatenated in order. */
const diskMessages = (cache: Map<string, any>, chatId = 'general'): any[] => {
  const keys: string[] = cache.get('replay:s:v3:meta')?.chunks?.[chatId] ?? [];
  return keys.flatMap((key) => cache.get(key)?.messages ?? []);
};
const onDisk = (h: any, chatId = 'general') => diskMessages(h.cache, chatId);

test('a save writes the chat that changed and the cursor, and the cursor goes last', async () => {
  const h = harness();
  await h.connect(seed(4, 20, 40));
  await h.join(0);
  assert.equal(h.phase(), 'idle');
  h.reset();

  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:c:general:0', 'replay:s:v3'], 'one chunk and the cursor, nothing else');
  assert.ok(onDisk(h).some((m: any) => m.id === 'm1'));
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 1);
  assert.equal(onDisk(h, 'chat2').length, 20, 'an untouched chat is still there from the first save');

  h.reset();
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'chat2', message: { ...msg(2), id: 'chat2-x', chat_id: 'chat2' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:c:chat2:0', 'replay:s:v3'], 'only the chat that changed is rewritten');
});

test("a save where a new chat's page appears rewrites meta with the new id", async () => {
  const h = harness();
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  assert.deepEqual([...h.cache.get('replay:s:v3:meta').pages].sort(), ['chat1', 'chat2', 'general'],
    'the first save named every page it wrote');
  h.reset();

  // A message for a chat this phone has not held before: its chunk is new, so meta must name it too.
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'fresh', message: { ...msg(1), id: 'fresh-1', chat_id: 'fresh' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:c:fresh:0', 'replay:s:t:fresh', 'replay:s:v3:meta', 'replay:s:v3'],
    'the new chunk, its (empty) tombstones, then a meta that names the chunk, then the cursor');
  assert.deepEqual([...h.cache.get('replay:s:v3:meta').pages].sort(), ['chat1', 'chat2', 'fresh', 'general'],
    'a restore reads the new chunk back because meta names it');
  assert.deepEqual(chunkKeys(h, 'fresh'), ['replay:s:c:fresh:0'], 'the chunk list is in the meta, not implied');
});

test('a save where only a meta slice changed rewrites meta and no page', async () => {
  const h = harness();
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  h.reset();

  // Renaming a chat changes the chat list and nothing else: no chunk's messages moved.
  h.event({ type: 'chat.update', event_seq: 1, chat_id: 'general', chat: { ...chat('general'), title: 'Renamed' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:v3:meta', 'replay:s:v3'], 'meta again, but no chunk is rewritten');
  assert.equal(h.cache.get('replay:s:v3:meta').chats.general.title, 'Renamed',
    'a restore reads the new chat list, not a stale one');
});

test('a streamed burst never writes the whole phone again', async () => {
  const h = harness();
  await h.connect(seed(8, 120, 400));
  await h.join(0);
  const whole = wholeStateBytes(h);
  assert.ok(whole > 400_000, `the seeded history is large (${whole} bytes)`);
  const firstSave = h.bytes(); // the migration save, which writes everything once
  assert.ok(firstSave > whole * 0.9, 'the first save after upgrade covers the whole state once');

  h.reset();
  // A burst of tokens for one message, arriving together as they do mid-reply.
  for (let seq = 1; seq <= 20; seq++) {
    h.event({ type: 'message.update', event_seq: seq, chat_id: 'general',
      message: msg(900, { status: 'streaming', text: 'y'.repeat(400) + seq }) });
  }
  await h.tick();
  const streamed = h.bytes();
  assert.ok(h.writes.length <= 2, `twenty queued events cost ${h.writes.length} save(s)`);
  assert.ok(streamed < whole, `the burst wrote ${streamed} bytes, less than one old whole-state save (${whole})`);
  assert.ok(h.writes.every((w) => w.bytes < 100_000), 'no single write is a whole-state payload');
  assert.match((onDisk(h).find((m: any) => m.id === 'm900') ?? {}).text ?? '',
    /^y{400}20$/, 'the last token of the burst is on disk');
});

test('per-event written bytes stay small however large the history is', async () => {
  const h = harness();
  await h.connect(seed(10, 300, 500));
  await h.join(0);
  const whole = wholeStateBytes(h);
  assert.ok(whole > 1_000_000, `a megabyte-plus history (${whole} bytes)`);
  const chunks = chunkKeys(h, 'general');
  assert.ok(chunks.length > 1, `the chat spans ${chunks.length} chunks`);
  h.reset();
  // A new message at the end of the chat: positions are the server's insertion order, so a middle one
  // would (correctly) move every message after it and rewrite their chunks.
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1, { position: 300 }) });
  await h.tick();
  assert.equal(h.store.getState().runtime.s.messages.general.length, 301);
  const perEvent = h.bytes();
  assert.ok(perEvent < 70_000, `one event wrote ${perEvent} bytes`);
  assert.ok(perEvent < whole / 5, `${perEvent} bytes is under a fifth of the ${whole}-byte whole state`);
  assert.deepEqual(h.keys(), [chunks[chunks.length - 1], 'replay:s:v3'], 'the tail chunk and the cursor');
});

test('a crash between the data write and the cursor write leaves the cursor behind its data', async () => {
  const cache = new Map<string, any>();
  const h = harness(cache);
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 1);

  // The next save's chunk lands, then the process dies before the cursor record can be written.
  h.failOn.add('replay:s:v3');
  h.reset();
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(2) });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:c:general:0'], 'the data was written, the cursor was not');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 1, 'the durable cursor is still behind the data');
  assert.ok(onDisk(h).some((m: any) => m.id === 'm2'));
  assert.equal(h.phase(), 'blocked', 'the failure still blocks replay progress');

  // A fresh app start reads that checkpoint back: newer data, older cursor, so replay covers the gap.
  const restarted = harness(cache);
  await restarted.connect();
  const before = restarted.messages().map((m: any) => m.id).join();
  assert.ok(before.includes('m2'), 'the applied message came back');

  // The server replays the event the cursor did not cover: applying it again must change nothing.
  await restarted.begin(2);
  await restarted.reply(2, 2, [{ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(2) }]);
  assert.equal(restarted.messages().map((m: any) => m.id).join(), before, 're-apply changed nothing');
  assert.equal(restarted.cache.get('replay:s:v3').cursor.cursor, 2, 'the cursor caught up');
});

test('a failed strict write is reported, and no cursor is written for a save that failed', async () => {
  const h = harness();
  await h.connect(seed(2, 10, 40));
  await h.join(0);
  h.failOn.add('replay:s:c:general:0');
  h.reset();
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.equal(h.phase(), 'blocked');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 0, 'no cursor was written for a save that failed');
  assert.deepEqual(h.keys(), [], 'and nothing followed the failed write');
  assert.ok(h.messages().some((m: any) => m.id === 'm1'),
    'the applied message is in memory; the next successful save persists it before any cursor');
});

test('a burst still in memory is written before the session is given up: a drop and a background', async () => {
  // The boundary that ends a session throws its pending mark away (closed()). A burst that has been
  // applied but not saved must therefore reach the disk first, or the newest transcript is lost and
  // recovery depends on how long the server keeps its journal.
  const burst = () => Array.from({ length: 12 }, (_, i) => ({ type: 'message.update', event_seq: i + 1,
    chat_id: 'general', message: msg(900, { status: 'streaming', text: 'x'.repeat(200) + String(i + 1) }) }));

  // 1. A dropped socket, with every frame of the burst still queued: nothing has even been applied.
  {
    const cache = new Map<string, any>();
    const h = harness(cache);
    await h.connect(seed(2, 10, 40));
    await h.join(0);
    for (const event of burst()) h.event(event);
    h.socket().readyState = 3; h.socket().onclose?.({ code: 1006 });
    await h.tick();
    const page = diskMessages(cache);
    assert.match((page.find((m: any) => m.id === 'm900') ?? {}).text ?? '', /x{200}12$/,
      'the last token of a burst still queued at the drop is on disk');
    assert.equal(cache.get('replay:s:v3').cursor.cursor, 12, 'and the cursor covers it');
  }

  // 2. A background, with the same burst still queued. The OS may kill the app from here, so it has to
  // be on disk before this settles. (This one cannot fail under a fake that is never killed; it pins
  // the intent; the drop case is what fails without the flush.)
  {
    const cache = new Map<string, any>();
    const h = harness(cache);
    await h.connect(seed(2, 10, 40));
    await h.join(0);
    for (const event of burst()) h.event(event);
    h.store.getState().setForeground(false);
    await h.tick();
    const page = diskMessages(cache);
    assert.match((page.find((m: any) => m.id === 'm900') ?? {}).text ?? '', /x{200}12$/,
      'going to the background left nothing unsaved');
    assert.equal(cache.get('replay:s:v3').cursor.cursor, 12);
    h.store.getState().setForeground(true);
  }

});

test('a dispose waits for the burst it still holds before giving the session up', async () => {
  // Connection.close() ends the session: closed() throws the pending mark away, so it must not run
  // while a save that carries the burst is still in flight.
  const { SyncSession } = sessionModule();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  const realWrite = h.write;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.write = async (cursor: any) => { await gate; return realWrite(cursor); };
  const burst = [1, 2, 3, 4, 5].map((seq) =>
    session.receive({ type: 'message.new', event_seq: seq, chat_id: 'general', message: msg(seq) }));
  await new Promise((r) => setImmediate(r));
  const ended = session.end();
  let gaveUp = false; void ended.then(() => { gaveUp = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(gaveUp, false, 'the session is not given up while its save is in flight');
  release();
  await Promise.all([...burst, ended]);
  assert.deepEqual(h.state.applied, [1, 2, 3, 4, 5], 'every event of the burst was applied');
  assert.equal(h.saved.cursor.cursor, 5, 'the cursor on disk covers the whole burst');
  assert.equal(h.saved.writes.at(-1).bytes, 5, 'the save that carried it saw all five applied');
  assert.equal(h.saved.writes.length, 1, 'the burst cost one save, not one per event');
  assert.equal(session.view().phase, 'idle');
  // A session that has given itself up is not resurrected by an event that arrives afterwards.
  await session.receive({ type: 'message.new', event_seq: 6, chat_id: 'general', message: msg(6) });
  assert.equal(h.saved.cursor.cursor, 5, 'nothing was written for a session that is gone');
});

test('a flush that outlives a reconnect does not wipe the session that replaced it', async () => {
  // A drop flushes before it closes, but the store's own retry can reconnect first: Connection.open()
  // calls closed(), and a fresh hello fills in the new stream, cursor and pending mark. A flush still
  // waiting on the disk must not clear those on its way out, or the socket stays up and never saves.
  const { SyncSession } = sessionModule();
  clearSessionClock();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  const realWrite = h.write;
  let release!: () => void;
  let writes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.write = async (cursor: any) => { if (writes++ === 0) await gate; return realWrite(cursor); };

  const burst = session.receive({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await new Promise((r) => setImmediate(r));
  const ended = session.end(); // the drop: it flushes, and the disk does not answer
  await new Promise((r) => setImmediate(r));

  session.closed(); // what the retry's open() does, on the same session
  await session.receive({ type: 'hello', chats: [], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 600 } });
  await session.receive({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark: 600,
    cursor: 600, has_more: false, events: [] });
  assert.equal(session.durable()?.cursor, 600, 'the new session caught up on its own');

  release(); // the abandoned flush finally lands
  await Promise.all([burst.catch(() => undefined), ended]);
  await new Promise((r) => setImmediate(r));
  assert.equal(session.durable()?.cursor, 600, 'the late flush did not clear the session that replaced it');
  assert.equal(session.view().phase, 'idle', 'and it is still the new session reporting, not a wiped one');

  // Its pending mark survived, so the socket still saves what it applies.
  await session.receive({ type: 'message.new', event_seq: 601, chat_id: 'general', message: msg(601) });
  assert.equal(h.saved.cursor.cursor, 601, 'the live socket still saves');
});

test('a session that did not reconnect still ends normally', async () => {
  const { SyncSession } = sessionModule();
  clearSessionClock();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  await session.receive({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await session.end();
  assert.equal(h.saved.cursor.cursor, 1, 'the burst reached the disk before the session ended');
  assert.equal(session.durable(), undefined, 'the session gave itself up');
  assert.equal(session.view().phase, 'idle');
  await session.receive({ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(2) });
  assert.equal(h.saved.cursor.cursor, 1, 'a session that is gone saves nothing more');

  // The failure path still reports itself: a burst that never reached the disk is not reported idle.
  const failing = host();
  const stuck = new SyncSession(failing, () => {});
  await caughtUp(stuck, failing);
  stuck.pending = 1; // applied but unsaved, as a burst whose save never ran leaves it
  failing.fail(true);
  await stuck.end();
  assert.equal(stuck.view().phase, 'blocked', 'a burst that never reached the disk is reported blocked');
  assert.equal(stuck.durable(), undefined);
});

test('a deleted chat loses its page record, and a chat that shares its prefix keeps its own', async () => {
  const h = harness();
  await h.connect(seed(2, 5, 20));
  await h.join(0);
  // Two chats whose ids prefix each other: removing the short one by prefix would take the long one too.
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'a', message: { ...msg(1), id: 'a-1', chat_id: 'a' } });
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'ab', message: { ...msg(2), id: 'ab-1', chat_id: 'ab' } });
  await h.tick();
  assert.ok(h.cache.has('replay:s:c:a:0') && h.cache.has('replay:s:c:ab:0'), 'both pages are on disk');

  h.event({ type: 'chat.delete', event_seq: 3, chat_id: 'a' });
  await h.tick();
  assert.equal(h.cache.has('replay:s:c:a:0'), false, "the deleted chat's page record is gone from disk");
  assert.ok(diskMessages(h.cache, 'ab').some((m: any) => m.id === 'ab-1'),
    'the chat whose id starts with the deleted one keeps its page');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 3, 'the save that pruned it still moved the cursor');
});

test('a failed retirement of the pre-split record is retried until it succeeds', async () => {
  const h = harness();
  h.failOn.add('replay:s');
  await h.connect(seed(2, 5, 20));
  await h.join(0);
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 0, 'the save that could not retire it still committed');
  assert.ok(h.cache.get('replay:s')?.state, 'the pre-split record is still there, not written off as retired');

  h.failOn.delete('replay:s');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.equal(h.cache.get('replay:s').retired, true, 'the next save retired it');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 1, 'and the cursor was unaffected by the retry');
});

test('a replayed inbox event cannot drag the badge back to its journal-time count', async () => {
  const cache = new Map<string, any>();
  cache.set('replay:s:v2', { v: 2, cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 } });
  cache.set('replay:s:meta', { chats: { general: chat('general') }, loaded: {}, inbox: {}, pending: 0, tasks: {}, pages: [] });
  const h = harness(cache);
  await h.connect();
  const pending = () => h.store.getState().runtime.s.pending;
  // Two items are waiting now, and the inbox snapshot says so.
  h.setRequest(async (_server: any, path: string) => (path === '/api/inbox'
    ? { items: [inboxItem('i1'), inboxItem('i2')], pending: 2 }
    : { items: [], pending: 0, messages: [], deleted_ids: [], pet: null, projects: undefined }));
  h.event({ type: 'hello', chats: [chat('general')], pending: 2, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 2 } });
  await h.tick();
  assert.equal(pending(), 2, 'two items waiting');

  // The journal replays an event from when nothing was waiting: applying that count would hide both.
  await h.reply(2, 2, [{ type: 'inbox.update', event_seq: 2, item: inboxItem('i3'), pending: 0 }]);
  assert.equal(pending(), 2, 'a replay keeps the count the app already has');

  // Live counts still move it both ways.
  h.event({ type: 'inbox.update', event_seq: 3, item: inboxItem('i4'), pending: 1 });
  await h.tick();
  assert.equal(pending(), 1, 'a live count down');
  h.event({ type: 'inbox.update', event_seq: 4, item: inboxItem('i5'), pending: 4 });
  await h.tick();
  assert.equal(pending(), 4, 'and a live count up');
});

test('a failed meta write writes no cursor and reports the save failed', async () => {
  const h = harness();
  await h.connect(seed(2, 5, 20));
  await h.join(0);
  // A rename changes the meta record and nothing else, so meta is the first write of the save.
  h.failOn.add('replay:s:v3:meta');
  h.reset();
  h.event({ type: 'chat.update', event_seq: 1, chat_id: 'general', chat: { ...chat('general'), title: 'Renamed' } });
  await h.tick();
  assert.equal(h.phase(), 'blocked', 'the failure reached the session');
  assert.deepEqual(h.keys(), [], 'nothing was written after the failed meta record');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 0, 'no cursor was written for a save that failed');
  assert.equal(h.cache.get('replay:s:v3:meta').chats.general.title, 'general', 'the old meta record is intact');
});

test('a restore survives a missing, an unnamed and a malformed chunk record', async () => {
  const cache = new Map<string, any>();
  cache.set('replay:s:v3', { v: 3, cursor: { scope: 'scope', epoch: 'epoch', cursor: 9 } });
  cache.set('replay:s:v3:meta', { v: 3, chats: { named: chat('named'), short: chat('short'), junk: chat('junk'),
    unnamed: chat('unnamed') }, loaded: {}, inbox: {}, pending: 0, tasks: {}, pages: ['named', 'short', 'junk'],
    chunks: { named: ['replay:s:c:named:0'],
      short: ['replay:s:c:short:0', 'replay:s:c:short:1'],
      junk: ['replay:s:c:junk:0'],
      unnamed: ['replay:s:c:unnamed:0'] } });
  cache.set('replay:s:c:named:0', { v: 3, messages: [msg(1, { chat_id: 'named', id: 'named-1' })] });
  cache.set('replay:s:c:short:0', { v: 3, messages: [msg(2, { chat_id: 'short', id: 'short-1' })] });
  // 'short' names a second chunk and no such record was written; 'junk' has one of the wrong shape;
  // 'unnamed' has a good record that the meta does not name, so nothing reads it back.
  cache.set('replay:s:c:junk:0', { v: 3, messages: 'not an array' });
  cache.set('replay:s:c:unnamed:0', { v: 3, messages: [msg(3, { chat_id: 'unnamed', id: 'unnamed-1' })] });
  const h = harness(cache);
  await h.connect();
  assert.equal(h.store.getState().runtime.s.chats.named?.title, 'named', 'the chat list came back');
  assert.equal(h.messages('named').map((m: any) => m.id).join(), 'named-1');
  assert.equal(h.messages('short').map((m: any) => m.id).join(), 'short-1', 'the chunk that was readable came back');
  assert.deepEqual(h.messages('gone'), [], 'a chat with no record restores empty, not broken');
  assert.deepEqual(h.messages('junk'), [], 'a malformed chunk is ignored');
  assert.deepEqual(h.messages('unnamed'), [], 'a chunk meta does not name is not read back');
  // That restore was short — 'short' names two chunks and only one was there — so nothing is adopted as
  // already saved: the first save after it writes those chats again rather than trusting their marks.
  h.reset();
  await h.begin(9);
  await h.reply(9, 9, []);
  assert.equal(h.phase(), 'idle', 'and the cursor it restored still resumes cleanly');
  const wrote = h.keys().filter((key) => key.includes(':c:'));
  assert.deepEqual([...wrote].sort(), ['replay:s:c:named:0', 'replay:s:c:short:0'],
    `the chats it read are written again, not trusted as saved (${wrote.join(', ')})`);
});

test('a whole page re-applied from a coarser cursor leaves the state identical', async () => {
  const cache = new Map<string, any>();
  const events = [
    { type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) },
    { type: 'message.update', event_seq: 2, chat_id: 'general', message: msg(1, { text: 'edited', updated_at: 5 }) },
    { type: 'task.event', event_seq: 3, chat_id: 'general', turn_index: 1, turn_id: 't', seq: 1, event: { kind: 'turn.started' } },
    { type: 'message.delete', event_seq: 4, chat_id: 'general', message_id: 'm1' },
    { type: 'chat.update', event_seq: 5, chat_id: 'general', chat: { ...chat('general'), title: 'Renamed' } },
  ];
  const first = harness(cache);
  await first.connect(seed(2, 6, 20));
  await first.begin(5);
  await first.reply(5, 5, events);
  assert.equal(first.phase(), 'idle');
  const once = () => {
    const rt = first.store.getState().runtime.s;
    const task = rt.tasks.general ? { ...rt.tasks.general, updated_at: 0 } : undefined;
    return JSON.stringify([rt.messages, rt.deleted, rt.chats, task]);
  };
  const after = once();

  // The cursor is lost (a crash between data and cursor, or a storage reset) and the server replays the
  // same page from an older one. Every handler must converge on the same state.
  cache.set('replay:s:v3', { v: 3, cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 } });
  const second = harness(cache);
  await second.connect();
  await second.begin(5);
  await second.reply(5, 5, events);
  const rt = second.store.getState().runtime.s;
  const task = rt.tasks.general ? { ...rt.tasks.general, updated_at: 0 } : undefined;
  assert.equal(JSON.stringify([rt.messages, rt.deleted, rt.chats, task]), after,
    're-applying the page changed nothing');
  assert.equal(second.cache.get('replay:s:v3').cursor.cursor, 5);
});

// ---------------------------------------------------------------------------------------------
// The session on its own: coalescing and failure propagation, with the host stubbed.

/** Timers a session scheduled on its own (its resume timeout), runnable on demand. */
const sessionClocks: Array<(() => void) | undefined> = [];
const runSessionClock = () => { for (const fn of sessionClocks.splice(0)) fn?.(); };
const clearSessionClock = () => { sessionClocks.length = 0; };

const sessionModule = () => {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/event-replay/session.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: (id: string) => {
      if (id === './protocol') {
        const protocol: any = {};
        vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/event-replay/protocol.ts', import.meta.url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText, { exports: protocol, require: () => ({}) });
        return protocol;
      }
      throw new Error(`Unexpected import ${id}`);
    },
    setTimeout: (fn: () => void) => { sessionClocks.push(fn); return sessionClocks.length - 1; },
    clearTimeout: (id: number) => { if (typeof id === 'number') sessionClocks[id] = undefined; },
  });
  return exports;
};

function host(options: { failWrites?: boolean; start?: number; snapshot?: any } = {}) {
  const fail = { on: options.failWrites === true };
  const counters = { disconnects: 0, blocked: 0 };
  const saved: { cursor?: any; writes: { cursor: any; bytes: number }[] } = {
    cursor: { scope: 'scope', epoch: 'epoch', cursor: options.start ?? 0 }, writes: [] };
  const state = { applied: [] as number[], appliedBack: 0, released: false };
  return {
    saved, state,
    fail: (on: boolean) => { fail.on = on; },
    read: () => saved.cursor,
    write: async (cursor: any) => {
      if (fail.on) throw new Error('storage full');
      saved.writes.push({ cursor, bytes: state.applied.length });
      saved.cursor = { ...cursor };
    },
    apply: (event: any) => { if (typeof event.event_seq === 'number') state.applied.push(event.event_seq); },
    applySnapshot: async () => { state.appliedBack++; },
    fetch: async () => options.snapshot ?? {},
    view: (view: any) => { if (view.phase === 'blocked') counters.blocked++; },
    disconnect: () => { counters.disconnects++; },
    counters,
  };
}

/** Bring a fresh session to idle, with nothing left in flight. */
async function caughtUp(session: any, h: any, watermark = 0) {
  await session.receive({ type: 'hello', chats: [], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark } });
  await session.receive({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark,
    cursor: watermark, has_more: false, events: [] });
  h.saved.writes.length = 0;
}

test('a burst of queued events costs one save, at the highest seq', async () => {
  const { SyncSession } = sessionModule();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  assert.equal(session.view().phase, 'idle');

  // Ten live events arrive together: the queue is drained by one save.
  const burst = Array.from({ length: 10 }, (_, i) => ({ type: 'message.new', event_seq: i + 1, chat_id: 'general', message: msg(i + 1) }));
  await Promise.all(burst.map((event) => session.receive(event)));
  assert.deepEqual(h.state.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every event was applied');
  assert.equal(h.saved.writes.length, 1, `ten queued events produced ${h.saved.writes.length} save(s)`);
  assert.equal(h.saved.writes[0].cursor.cursor, 10, 'the one save covers the whole burst');

  // A single event on its own still saves immediately.
  await session.receive({ type: 'message.new', event_seq: 11, chat_id: 'general', message: msg(11) });
  assert.equal(h.saved.writes.length, 2);
  assert.equal(h.saved.writes[1].cursor.cursor, 11);
});

test('the cursor only moves after its save resolves, and a failed save stops the burst', async () => {
  const { SyncSession } = sessionModule();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  h.fail(true);
  await session.receive({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  assert.deepEqual(h.state.applied, [1], 'the event was applied before its save was attempted');
  assert.equal(session.view().phase, 'blocked', 'the failure blocked the session');
  assert.equal(h.saved.cursor.cursor, 0, 'no cursor was acknowledged');
  assert.equal(h.saved.writes.length, 0);

  // Events that arrive while blocked are held, not applied on top of a state nobody saved.
  await session.receive({ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(2) });
  assert.deepEqual(h.state.applied, [1], 'later events wait for a retry');
});

test('a retry after a failed save re-snapshots, and only then moves the cursor', async () => {
  const { SyncSession } = sessionModule();
  const h = host({ snapshot: { scope: 'scope', server_id: 's', epoch: 'epoch', watermark: 7,
    chats: [], inbox: [], pending: 0 } });
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  h.fail(true);
  await session.receive({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  assert.equal(session.view().phase, 'blocked');
  assert.equal(h.saved.cursor.cursor, 0);

  h.fail(false);
  session.retry();
  await session.receive({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark: 7, cursor: 7, has_more: false, events: [] });
  assert.equal(h.state.appliedBack, 1, 'the retry reloaded the authoritative state');
  assert.equal(h.saved.cursor.cursor, 7, 'the cursor advanced only after a save that covered it');
  assert.equal(session.view().phase, 'idle');
});

test('a page overlapping the saved cursor applies only what is new', async () => {
  const { SyncSession } = sessionModule();
  const h = host({ start: 2 });
  const session = new SyncSession(h, () => {});
  await session.receive({ type: 'hello', chats: [], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  h.saved.writes.length = 0;
  await session.receive({ type: 'resume', ok: true, scope: 'scope', epoch: 'epoch', watermark: 5, cursor: 5,
    has_more: false, events: [1, 2, 3, 4, 5].map((seq) => ({ type: 'message.new', event_seq: seq, chat_id: 'general', message: msg(seq) })) });
  assert.deepEqual(h.state.applied, [3, 4, 5], 'the two events the cursor already covered were not applied again');
  assert.equal(h.saved.cursor.cursor, 5, 'the cursor is the reply watermark, not the last event');
  assert.equal(session.view().phase, 'idle');
});

test('the in-memory cursor does not move before its write resolves', async () => {
  // The rule is that the cursor is never ahead of the data. Assigning it before the await moves it
  // while the disk still holds the older one, and a burst that fails afterwards would resume from a
  // cursor the disk never took.
  const { SyncSession } = sessionModule();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  const realWrite = h.write;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.write = async (cursor: any) => { await gate; return realWrite(cursor); };
  const saving = session.receive({ type: 'message.new', event_seq: 7, chat_id: 'general', message: msg(7) });
  await new Promise((r) => setImmediate(r));
  assert.equal(session.durable()?.cursor, 0, 'the reported cursor stays on the value the disk has');
  release();
  await saving;
  assert.equal(session.durable()?.cursor, 7, 'and moves once the write has resolved');
  assert.equal(h.saved.cursor.cursor, 7);

  // A write that fails must not leave the session believing a cursor the disk never took.
  let fail!: (e: Error) => void;
  const refuses = new Promise<void>((_, reject) => { fail = reject; });
  h.write = async (cursor: any) => { await refuses; return realWrite(cursor); };
  const failed = session.receive({ type: 'message.new', event_seq: 8, chat_id: 'general', message: msg(8) });
  await new Promise((r) => setImmediate(r));
  fail(new Error('storage full'));
  await failed;
  assert.equal(session.durable()?.cursor, 7, 'a failed write leaves the reported cursor at the last durable one');
  assert.equal(h.saved.cursor.cursor, 7);
  assert.equal(session.view().phase, 'blocked');
});


// ---------------------------------------------------------------------------------------------
// One save at a time per bot: a retiring connection cannot undo the save that replaced it.

/** session.ts's MAX_HELD: the queue depth a live burst may reach before the session gives up. */
const HEAP_LIMIT = 512;

test('a save that lost the race cannot move the cursor back or put an older page over a newer one', async () => {
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  h.reset();
  // The burst is applied and its first write is in flight when the connection is retired.
  const release = h.hold('replay:s:c:general:0');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101) });
  await h.tick();
  assert.deepEqual(h.keys(), [], 'the page write is still in flight');

  // The replacement resumes from the cursor the disk holds, and catches up to 5 on its own.
  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  h.event({ type: 'hello', chats: [chat('general')], pending: 0, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  await h.tick();
  await h.reply(5, 5, [1, 2, 3, 4, 5].map((n) => ({ type: 'message.new', event_seq: n, chat_id: 'general', message: msg(100 + n) })));

  // The retiring save is released: it had already planned its writes from the older state.
  release();
  await h.tick();

  const cursors = h.cursorWrites();
  assert.equal(cursors[cursors.length - 1], 5, `the durable cursor is the newer one (wrote ${cursors.join(', ')})`);
  assert.deepEqual([...cursors].sort((a: number, b: number) => a - b), cursors,
    `the cursor never went backwards (wrote ${cursors.join(', ')})`);
  const ids = (diskMessages(h.cache)).map((m: any) => m.id);
  assert.ok(ids.includes('m105'), `the newer page was not replaced by an older snapshot (${ids.join(', ')})`);
  assert.ok(ids.includes('m101'), 'and the retired connection\'s own messages are still there');
});

test('once the replacement has committed, a save the chain gave up on writes nothing at all', async () => {
  // The window the cold review found: the chain's bound fires while a retiring save is between two of
  // its page writes. The replacement commits its own pages and its cursor; the abandoned save still
  // owes its planned chat1 page. Writing it would leave the cursor covering a page record that no
  // longer holds the messages it covers — and the refs the replacement recorded mean no later save
  // rewrites that chat, so the loss is permanent.
  const h = harness();
  await h.connect(seed(2, 5, 20));
  await h.join(0);
  h.reset();
  const c = (n: number) => ({ ...msg(n), id: `c${n}`, chat_id: 'chat1' });
  const release = h.hold('replay:s:c:general:0');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101) });
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'chat1', message: c(102) });
  await h.tick();
  assert.deepEqual(h.keys(), [], 'both writes of the bursting save are behind the held one');

  // The replacement takes over and catches up to 5, with newer messages in chat1.
  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  h.event({ type: 'hello', chats: [chat('general'), chat('chat1')], pending: 0, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  await h.tick();
  await h.reply(5, 5, [1, 2, 3, 4, 5].map((n) => ({ type: 'message.new', event_seq: n,
    chat_id: n === 1 ? 'general' : 'chat1', message: n === 1 ? msg(100 + n) : c(100 + n) })));
  h.runStoreTimers(); // the chain stops waiting on the save the device never answered
  await h.tick();
  const ids = (id: string) => diskMessages(h.cache, id).map((m: any) => m.id);
  assert.ok(ids('chat1').includes('c105'), 'the replacement\'s chat1 page is on the disk');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 5, 'and its cursor is durable');

  // The held write finally lands, as a device that stalled for longer than the bound does. The
  // abandoned save's next planned key is chat1, and that page must not be written.
  release();
  await h.tick();
  assert.ok(ids('chat1').includes('c105'),
    `the abandoned save put its older chat1 page over the newer one (${ids('chat1').join(', ')})`);
  const cursors = h.cursorWrites();
  assert.equal(cursors[cursors.length - 1], 5, `the durable cursor is the newer one (wrote ${cursors.join(', ')})`);
  assert.deepEqual([...cursors].sort((a: number, b: number) => a - b), cursors,
    `the cursor never went backwards (wrote ${cursors.join(', ')})`);
  assert.ok(ids('general').includes('m101'), 'the cursor still covers data that is on the disk');
});

test('a retiring save stops at its next key once a newer save has started', async () => {
  // The strict cursor check alone only stops a retiring save once the newer cursor is durable. A save
  // between two of its writes has to stop at the newer save's start: that save has already written the
  // pages this one would put back, and only its cursor is still to land.
  const h = harness();
  await h.connect(seed(2, 5, 20));
  await h.join(0);
  h.reset();
  const c = (n: number) => ({ ...msg(n), id: `c${n}`, chat_id: 'chat1' });
  const release = h.hold('replay:s:c:general:0');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101) });
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'chat1', message: c(102) });
  await h.tick();

  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  h.event({ type: 'hello', chats: [chat('general'), chat('chat1')], pending: 0, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  await h.tick();
  // The replacement's own cursor write is the one still in flight when the abandoned save wakes up.
  const releaseCursor = h.hold('replay:s:v3');
  await h.reply(5, 5, [1, 2, 3, 4, 5].map((n) => ({ type: 'message.new', event_seq: n,
    chat_id: n === 1 ? 'general' : 'chat1', message: n === 1 ? msg(100 + n) : c(100 + n) })));
  h.runStoreTimers();
  await h.tick();
  const ids = (id: string) => diskMessages(h.cache, id).map((m: any) => m.id);
  assert.ok(ids('chat1').includes('c105'), 'the replacement wrote its chat1 page before its cursor landed');

  release();
  await h.tick();
  assert.ok(ids('chat1').includes('c105'),
    `a save that lost the race put its older page back over the newer one (${ids('chat1').join(', ')})`);
  releaseCursor();
  await h.tick();
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 5, 'and the newer cursor is the one on the disk');
  assert.ok(ids('chat1').includes('c105'), 'so the cursor does not cover a page that lost its messages');
});

test('a save that never settles cannot hold the next save for ever', async () => {
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  h.reset();
  // A write the device never answers: the save stays in the chain for ever.
  h.hold('replay:s:c:general:0');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101) });
  await h.tick();
  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  h.event({ type: 'hello', chats: [chat('general')], pending: 0, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  await h.tick();
  await h.reply(5, 5, [1, 2, 3, 4, 5].map((n) => ({ type: 'message.new', event_seq: n, chat_id: 'general', message: msg(100 + n) })));
  assert.equal(h.cache.get('replay:s:v3')?.cursor?.cursor, 0, 'the replacement is waiting, not silently stuck');

  h.runStoreTimers(); // the chain stops waiting on the abandoned save
  await h.tick();
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 5, 'the next save ran anyway');
  assert.equal(h.phase(), 'idle');
});

test('the chain waits a bounded few seconds for a save that never settles', async () => {
  // The bound's magnitude is the whole argument in both directions: zero lets every save race the one
  // it should have waited for, and a minute is a stall the phone shows. The other half — a save that
  // settles inside the bound keeps the chain ordered — is the race test above, which never fires it.
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  const pending = h.storeTimerDelays().length;
  h.reset();
  h.hold('replay:s:c:general:0'); // a write the device never answers
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101) });
  await h.tick();
  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  h.event({ type: 'hello', chats: [chat('general')], pending: 0, features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 5 } });
  await h.tick();
  await h.reply(5, 5, [1, 2, 3, 4, 5].map((n) => ({ type: 'message.new', event_seq: n, chat_id: 'general', message: msg(100 + n) })));

  const bound = h.storeTimerDelays().slice(pending);
  assert.equal(bound.length, 1, `the second save armed exactly one timer (${bound.join(', ')})`);
  assert.ok(bound[0] >= 2000 && bound[0] <= 30000,
    `a few seconds: 0 would let the saves race and 60 s is a stall (${bound[0]} ms)`);
  assert.deepEqual(h.cursorWrites(), [], 'the second save waits inside the bound');
  h.runStoreTimers();
  await h.tick();
  assert.deepEqual([...new Set(h.cursorWrites())], [5], 'and only then moves the cursor to its own');
});

// ---------------------------------------------------------------------------------------------
// The session's own end-of-life boundaries must flush a burst before they drop it.

test('a queue that overruns flushes the burst it holds before giving the session up', async () => {
  const { SyncSession } = sessionModule();
  clearSessionClock();
  const h = host();
  const session = new SyncSession(h, () => {});
  await caughtUp(session, h);
  const realWrite = h.write;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.write = async (cursor: any) => { await gate; return realWrite(cursor); };
  // One frame past the limit: the session gives itself up with 512 applied frames still unsaved.
  const events = Array.from({ length: HEAP_LIMIT + 1 }, (_, i) =>
    ({ type: 'message.new', event_seq: i + 1, chat_id: 'general', message: msg(i + 1) }));
  const all = events.map((event) => session.receive(event));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all(all);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(h.state.applied.length, HEAP_LIMIT, 'every frame the session accepted was applied');
  assert.equal(h.saved.cursor.cursor, HEAP_LIMIT, 'and the burst reached the disk before the session went');
  assert.equal(h.counters.disconnects, 1, 'the socket was still given up');
});

test('a resume that never answers flushes the burst it holds before giving the session up', async () => {
  const { SyncSession } = sessionModule();
  clearSessionClock();
  const h = host();
  const session = new SyncSession(h, () => {});
  await session.receive({ type: 'hello', chats: [], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 4 } });
  assert.equal(session.view().phase, 'catching-up');
  // Nothing is applied while a session is catching up, so a pending mark cannot arise here on its own.
  // Set it directly: this test is about where the timeout route sends it, not about how it got there.
  session.pending = 4;
  runSessionClock(); // the resume timeout fires
  await new Promise((r) => setImmediate(r));

  assert.equal(h.saved.cursor.cursor, 4, 'the burst was written before the session was given up');
  assert.equal(h.counters.disconnects, 1, 'and the socket was disconnected');
  assert.equal(session.view().phase, 'idle');

  // A flush that cannot complete still says blocked, though the session is gone.
  const failing = host({ failWrites: true });
  const second = new SyncSession(failing, () => {});
  await second.receive({ type: 'hello', chats: [], features: { event_replay: true },
    event_stream: { scope: 'scope', epoch: 'epoch', watermark: 4 } });
  second.pending = 4;
  runSessionClock();
  await new Promise((r) => setImmediate(r));
  assert.equal(second.view().phase, 'blocked', 'a flush that failed is not reported as an idle session');
  assert.equal(failing.counters.disconnects, 1);
});

test('dropping to the background flushes what the connection still holds', async () => {
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  h.flushCalls.length = 0;
  h.store.getState().setForeground(false);
  await h.tick();
  // The OS may kill the app on the way out: presence(false) is the only put-it-on-disk moment left.
  assert.deepEqual(h.flushCalls, ['flush']);
});

// ---------------------------------------------------------------------------------------------
// Hygiene that has to look past the records this session wrote.

test('chunk records no checkpoint names are swept at launch, and only at launch', async () => {
  const cache = new Map<string, any>();
  cache.set('replay:s:v3', { v: 3, cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 } });
  cache.set('replay:s:v3:meta', { v: 3, chats: { general: chat('general') }, loaded: {}, inbox: {}, pending: 0,
    tasks: {}, pages: ['general'], chunks: { general: ['replay:s:c:general:0'] } });
  cache.set('replay:s:c:general:0', { v: 3, messages: [msg(1)] });
  cache.set('replay:s:c:ghost:0', { v: 3, messages: [msg(9, { id: 'g1', chat_id: 'ghost' })] });
  const h = harness(cache);
  await h.connect();
  await h.tick();
  assert.equal(cache.has('replay:s:c:ghost:0'), false, 'a chunk record nothing names is gone');
  assert.ok(diskMessages(cache).some((m: any) => m.id === 'm1'), 'a named chunk is kept');
  assert.ok(cache.has('replay:s:v3'), 'and the checkpoint itself is untouched');

  // A record left by an interrupted prune, put back: a save is not a launch and must not sweep. This
  // half has to go through a path that really saves — with no session the frame is only applied in
  // memory, nothing is written, and the assertion could not fail.
  cache.set('replay:s:c:ghost:0', { v: 3, messages: [] });
  await h.begin(0);
  await h.reply(0, 0);
  h.reset();
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(2, { id: 'm2' }) });
  await h.tick();
  assert.deepEqual(h.cursorWrites(), [1], 'the frame went through a save');
  assert.ok(cache.has('replay:s:c:ghost:0'), 'a later save does not sweep again');
});

test('a checkpoint that cannot be read sweeps nothing', async () => {
  const cache = new Map<string, any>();
  cache.set('replay:s:v2', { v: 2, cursor: { scope: 'scope', epoch: 'epoch', cursor: 'nonsense' } });
  cache.set('replay:s:meta', { chats: { general: chat('general') }, loaded: {}, inbox: {}, pending: 0, tasks: {}, pages: ['general'] });
  cache.set('replay:s:m:ghost', { messages: [], deleted: [] });
  const h = harness(cache);
  await h.connect();
  await h.tick();
  assert.ok(cache.has('replay:s:m:ghost'), 'a failed load deletes nothing');
});

test('a replacement opens even when retiring the old connection throws', async () => {
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  h.failCloses(1); // the retiring socket refuses to close
  const before = h.sockets().length;
  await h.store.getState().updateServer('s', { token: 'next' } as any, true);
  await h.tick();
  await h.begin(5);
  await h.reply(5, 5);
  assert.equal(h.sockets().length, before + 1, 'the replacement was opened');
  assert.equal(h.phase(), 'idle', 'and caught up: the throw did not escape or block it');
});

test('a bot that is removed and re-paired owes nothing from its old life', async () => {
  const h = harness();
  const cache = h.cache;
  // A retirement and a prune that cannot succeed yet: both stay owed to bot 's'.
  h.failOn.add('replay:s');
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  assert.notEqual(cache.get('replay:s')?.retired, true, 'the retirement is still owed');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'gone', message: msg(60, { id: 'g1', chat_id: 'gone' }) });
  await h.tick();
  h.failOn.add('replay:s:c:gone:0');
  h.event({ type: 'chat.delete', event_seq: 2, chat_id: 'gone' });
  await h.tick();
  assert.ok(cache.has('replay:s:c:gone:0'), 'the prune is still owed');
  h.failOn.clear();

  await h.store.getState().removeServer('s');
  assert.equal([...cache.keys()].some((k) => k.startsWith('replay:s')), false, 'its checkpoint is gone');

  // Re-pairing the same id writes a fresh checkpoint. The record the old life still owes is the same key
  // as the one the new life writes, so this is where a stale prune would delete fresh data.
  cache.set('replay:s:v2', { v: 2, cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 } });
  cache.set('replay:s:meta', { chats: { gone: chat('gone') }, loaded: {}, inbox: {}, pending: 0, tasks: {}, pages: ['gone'] });
  cache.set('replay:s:m:gone', { messages: [], deleted: [] });
  // A record the old life left behind that nothing names, so a launch sweep would take it.
  cache.set('replay:s:m:orphan', { messages: [msg(9, { id: 'o1', chat_id: 'orphan' })], deleted: [] });
  await h.store.getState().addServer({ id: 's', url: 'http://test', token: 'test', deviceId: 'dev', bot: { title: 'Again' } });
  // The pairing flow hydrates before it connects, as a cold launch does; addServer alone does not.
  h.store.setState({ ready: false } as any);
  await h.store.getState().init();
  await h.tick();
  await h.begin(0);
  await h.reply(0, 0);
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'gone', message: msg(61, { id: 'g2', chat_id: 'gone' }) });
  await h.tick();

  // What must not survive is the prune queued by the old life, which would delete the record just written.
  assert.deepEqual(diskMessages(cache, 'gone').map((m: any) => m.id), ['g2'], 'the fresh chunk still holds its message');
  assert.equal(cache.has('replay:s:m:gone'), false, 'the v2 record it replaced is gone');
  assert.equal(cache.has('replay:s:m:orphan'), false, 'and the re-paired bot is swept like any other launch');
});

// ---------------------------------------------------------------------------------------------
// A chat's messages are stored as ordered chunks: one new message must seal a small tail, never the
// whole chat. These pin the cost and the correctness of the layout that buys it.

test('a new message in a 5,000-message chat writes one small chunk, and the meta stays small', async () => {
  const h = harness();
  await h.connect(seed(1, 5000, 430));
  await h.join(0);
  const chunks = chunkKeys(h, 'general');
  assert.ok(chunks.length > 20, `the history is stored as ${chunks.length} chunks`);
  const whole = onDisk(h).reduce((n: number, m: any) => n + JSON.stringify(m).length, 0);
  assert.ok(whole > 2_000_000, `a phone-sized history (${whole} bytes)`);
  const meta = JSON.stringify(h.cache.get('replay:s:v3:meta'));
  assert.ok(meta.length < 8_192,
    `the meta naming ${chunks.length} chunks of a 5,000-message chat is ${meta.length} bytes`);

  h.reset();
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(5001, { position: 5000 }) });
  await h.tick();
  const tail = chunks[chunks.length - 1];
  assert.deepEqual(h.keys(), [tail, 'replay:s:v3'], 'the tail chunk and the cursor, no other chunk');
  const bytes = h.bytes();
  assert.ok(bytes < 70_000, `one new message wrote ${bytes} bytes, not the ${whole}-byte history`);
  assert.ok(bytes < whole / 10, `${bytes} bytes is under a tenth of the chat`);
  const page = onDisk(h);
  assert.equal(page.length, 5001, 'nothing was lost or duplicated');
  assert.equal(page[5000].id, 'm5001', 'the new message is last on disk, where it belongs');
});

test('editing an old message rewrites only the chunk it is in', async () => {
  const h = harness();
  await h.connect(seed(1, 900, 500));
  await h.join(0);
  const chunks = chunkKeys(h, 'general');
  assert.ok(chunks.length >= 3, `the chat spans ${chunks.length} chunks`);
  const target = onDisk(h)[5];
  h.reset();
  // A shorter text as well: the edit changes its chunk's size, and still stays in its own chunk.
  h.event({ type: 'message.update', event_seq: 1, chat_id: 'general',
    message: { ...target, text: 'edited', updated_at: target.updated_at + 1 } });
  await h.tick();
  assert.deepEqual(h.keys(), [chunks[0], 'replay:s:v3'], 'the edited chunk and the cursor, no other chunk');
  const after = onDisk(h);
  assert.equal(after.length, 900, 'no message was added or lost');
  assert.equal(after[5].text, 'edited', 'and the edit is on disk');
});

test('a restore concatenates the chunks back to the exact array, across boundaries and with tombstones', async () => {
  const cache = new Map<string, any>();
  const h = harness(cache);
  await h.connect(seed(2, 400, 500));
  await h.join(0);
  h.event({ type: 'message.delete', event_seq: 1, chat_id: 'general', message_id: 'general-7' });
  await h.tick();
  const chunks = chunkKeys(h, 'general');
  assert.ok(chunks.length >= 4, `several chunks to join (${chunks.length})`);
  const stored = onDisk(h);
  assert.equal(stored.length, 399);
  assert.deepEqual(Array.from(h.cache.get('replay:s:t:general').deleted), ['general-7']);

  const again = harness(cache);
  await again.connect();
  // The store runs in its own realm, so its arrays are copied out before a strict comparison.
  const ids = Array.from(again.messages() as any[]).map((m: any) => m.id);
  const want = stored.map((m: any) => m.id);
  assert.deepEqual(ids, want, 'the same messages, in the same order');
  assert.equal(new Set(ids).size, ids.length, 'nothing duplicated');
  assert.deepEqual(Array.from(again.store.getState().runtime.s.deleted.general), ['general-7'], 'the tombstones came back');
});

test('a v2 whole-chat page loads on the first launch, and the first save replaces it with chunks', async () => {
  const cache = new Map<string, any>();
  cache.set('replay:s:v2', { v: 2, cursor: { scope: 'scope', epoch: 'epoch', cursor: 7 } });
  cache.set('replay:s:meta', { chats: { general: chat('general') }, loaded: { general: true }, inbox: {}, pending: 0,
    tasks: {}, pages: ['general'] });
  const page = Array.from({ length: 40 }, (_, i) => msg(i, { chat_id: 'general', id: `v2-${i}` }));
  cache.set('replay:s:m:general', { messages: page, deleted: ['gone-1'] });
  const h = harness(cache);
  await h.connect();
  assert.deepEqual(h.messages().map((m: any) => m.id), page.map((m) => m.id), "the old build's history is all there");
  assert.deepEqual(Array.from(h.store.getState().runtime.s.deleted.general), ['gone-1']);
  assert.equal(h.store.getState().runtime.s.loaded.general, true, 'and the rest of the old meta with it');

  await h.begin(7);
  await h.reply(7, 7, []);
  h.event({ type: 'message.new', event_seq: 8, chat_id: 'general', message: msg(40, { position: 40, id: 'v2-40' }) });
  await h.tick();
  assert.deepEqual(chunkKeys(h, 'general'), ['replay:s:c:general:0'], 'the history is stored as chunks now');
  assert.equal(onDisk(h).length, 41);
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 8);
  assert.equal(h.cache.has('replay:s:m:general'), false, 'the v2 page goes once the v3 cursor is on the disk');
  assert.equal(h.cache.has('replay:s:meta'), false);
  assert.equal(h.cache.has('replay:s:v2'), false);

  const again = harness(cache);
  await again.connect();
  assert.equal(again.messages().length, 41, 'a restore of the new layout is the same history');
  assert.deepEqual(Array.from(again.store.getState().runtime.s.deleted.general), ['gone-1']);
});

test('deleting a chat removes every chunk it owned and its tombstones', async () => {
  const h = harness();
  await h.connect(seed(2, 400, 500));
  await h.join(0);
  h.event({ type: 'message.delete', event_seq: 1, chat_id: 'general', message_id: 'general-7' });
  await h.tick();
  const chunks = chunkKeys(h, 'general');
  assert.ok(chunks.length >= 4, `the chat spans ${chunks.length} chunks`);
  assert.ok(h.cache.has('replay:s:t:general'), 'its tombstones are their own record');
  assert.deepEqual(chunks.filter((key) => !h.cache.has(key)), [], 'every chunk is on disk before the delete');

  h.event({ type: 'chat.delete', event_seq: 2, chat_id: 'general' });
  await h.tick();
  assert.deepEqual(chunks.filter((key) => h.cache.has(key)), [], 'every chunk it owned is gone');
  assert.equal(h.cache.has('replay:s:t:general'), false, 'and its tombstones with them');
  assert.deepEqual(chunkKeys(h, 'general'), [], 'the meta names none of them any more');
  const other = chunkKeys(h, 'chat1');
  assert.ok(other.length > 0 && other.every((key) => h.cache.has(key)), 'the other chat keeps its own');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 2, 'and the save that pruned it still moved the cursor');
});

test('two saves in flight still serialise, chunk by chunk', async () => {
  const h = harness();
  await h.connect(seed(1, 5, 20));
  await h.join(0);
  h.reset();
  const release = h.hold('replay:s:c:general:0');
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(101, { position: 5 }) });
  await h.tick();
  assert.deepEqual(h.keys(), [], 'the first save is inside its chunk write');
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(102, { position: 6 }) });
  await h.tick();
  assert.deepEqual(h.keys(), [], 'the second save waits for the first');
  release();
  await h.tick();
  assert.deepEqual(h.cursorWrites(), [1, 2], 'each save wrote its own cursor, in order');
  const ids = onDisk(h).map((m: any) => m.id);
  assert.equal(ids.length, 7, 'neither message was duplicated and none lost');
  assert.ok(ids.includes('m101') && ids.includes('m102'), 'both messages are on disk');
});

// ---------------------------------------------------------------------------------------------
// Cold review v4: a prune that cannot delete, the identity invariant, and the layout a load adopts.

/** The weight the checkpoint gives a message: its serialised length, plus the separator. */
const weightOf = (message: any) => JSON.stringify(message).length + 1;

/**
 * A one-chat history whose messages total just past the chunk target, so a single append crosses a chunk
 * boundary and a single delete uncrosses it: the prune cases need that to be exact rather than lucky.
 * `over` is how far past the target the total lands.
 */
function acrossBoundary(h: any, over = 200, textLen = 430) {
  const target: number = h.checkpoint.CHUNK_TARGET_BYTES;
  const messages: any[] = [];
  let total = 0;
  while (total < target - 2000) {
    const message = msg(messages.length, { id: `general-${messages.length}`, text: 'x'.repeat(textLen) });
    messages.push(message);
    total += weightOf(message);
  }
  // The last message is padded so the total lands exactly `over` bytes past the target: the JSON of the
  // same message with no text is its fixed part, and each padding character adds one byte.
  const last = msg(messages.length, { id: `general-${messages.length}`, text: '' });
  const fixed = weightOf(last);
  last.text = 'x'.repeat(target + over - total - fixed);
  messages.push(last);
  assert.equal(messages.reduce((sum, message) => sum + weightOf(message), 0), target + over,
    'the fixture ends exactly `over` bytes past a chunk boundary');
  return { chats: { general: chat('general') }, messages: { general: messages } };
}

/** A whole checkpoint as the restore would assemble it, readable straight from the harness cache. */
const loadFrom = (h: any, cache: Map<string, any>) =>
  h.checkpoint.loadCheckpoint('s', async (key: string, fallback: any) =>
    (cache.has(key) ? structuredClone(cache.get(key)) : fallback));

test('a prune whose delete failed cannot delete the chunk the next save writes and names', async () => {
  const h = harness();
  await h.connect(acrossBoundary(h));
  await h.join(0);
  const chunks = Array.from(chunkKeys(h, 'general'));
  assert.equal(chunks.length, 2, 'the chat starts as two chunks');
  const ids = onDisk(h).map((m: any) => m.id);

  // The chat shrinks to one chunk, and the delete of the record it no longer owns fails once.
  h.failDeleteOn.add('replay:s:c:general:1');
  h.event({ type: 'message.delete', event_seq: 1, chat_id: 'general', message_id: ids[ids.length - 1] });
  await h.tick();
  assert.deepEqual(chunkKeys(h, 'general'), ['replay:s:c:general:0'], 'one chunk is named now');
  assert.ok(h.cache.has('replay:s:c:general:1'), 'the failed prune leaves the record on the disk');

  // The chat regrows across the same boundary, so this save writes and names the very key that the
  // earlier save queued for deletion: chunk keys are positional, and the key is live again.
  h.failDeleteOn.clear();
  h.reset();
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'general',
    message: msg(1, { id: 'general-live', position: ids.length - 1 + 1, text: 'y'.repeat(4000), updated_at: 9000 }) });
  await h.tick();
  assert.deepEqual(h.keys().filter((key) => key.includes(':c:')), ['replay:s:c:general:1'],
    'the save wrote the chunk the chat regrew into');
  assert.deepEqual(chunkKeys(h, 'general'), ['replay:s:c:general:0', 'replay:s:c:general:1'],
    'and the meta names it');
  assert.ok(h.cache.has('replay:s:c:general:1'), 'the live record survives the hygiene of the save that wrote it');

  // A record the meta names is readable, so the restore is complete and holds the whole chat.
  const loaded = await loadFrom(h, h.cache);
  assert.equal(loaded.complete, true, 'nothing the meta names is missing from the disk');
  const again = harness(h.cache);
  await again.connect();
  assert.deepEqual(Array.from(again.messages() as any[]).map((m: any) => m.id), onDisk(h).map((m: any) => m.id),
    'the restored chat is the one that was written, not a short one');
});

test('a chat that shrinks past a chunk boundary prunes the chunk it no longer owns', async () => {
  const h = harness();
  await h.connect(acrossBoundary(h));
  await h.join(0);
  assert.equal(chunkKeys(h, 'general').length, 2, 'two chunks to start with');
  const ids = onDisk(h).map((m: any) => m.id);

  h.reset();
  h.event({ type: 'message.delete', event_seq: 1, chat_id: 'general', message_id: ids[ids.length - 1] });
  await h.tick();
  // Removing the tail drops the chat under the target, so a fresh cut is one chunk and the second record
  // is nobody's: the save has to prune it, not merely stop naming it.
  assert.deepEqual(chunkKeys(h, 'general'), ['replay:s:c:general:0'], 'one chunk is named');
  assert.equal(h.cache.has('replay:s:c:general:1'), false, 'the record nothing names is deleted');
  assert.deepEqual(onDisk(h).map((m: any) => m.id), ids.slice(0, -1), 'the messages that remain are intact');
  assert.equal(h.cache.get('replay:s:v3').cursor.cursor, 1, 'on a save that also moved the cursor');
});

test('a v3 checkpoint whose tombstone record is missing is not adopted as already saved', async () => {
  const h = harness();
  await h.connect(seed(1, 4, 40));
  await h.join(0);
  h.event({ type: 'message.delete', event_seq: 1, chat_id: 'general', message_id: 'general-1' });
  await h.tick();
  assert.deepEqual(h.cache.get('replay:s:t:general').deleted, ['general-1'], 'the tombstones are on the disk');

  // The tombstone record goes missing: the load cannot know which ids were deleted, so it is unfinished
  // in exactly the way a malformed record is, and adopting it would lose the deletion for good.
  h.cache.delete('replay:s:t:general');
  const loaded = await loadFrom(h, h.cache);
  assert.equal(loaded.complete, false, 'a missing tombstone record makes the restore incomplete');

  const again = harness(h.cache);
  await again.connect();
  await again.join(1);
  // Not adopted, so the first save after the load writes the chat back — including the record the load
  // could not read, which is how an absent tombstone record heals itself.
  assert.ok(again.keys().includes('replay:s:t:general'), 'the next save writes that chat\'s tombstones');
});

/** Each message's identity and its content, so a path can be checked for an edit that landed in place. */
const snapshotOf = (list: any[]) => new Map(list.map((message: any) => [message.id, { object: message, json: JSON.stringify(message) }]));

/**
 * The invariant: a message whose content changed must be a different object. If any path ever edited a
 * message in place, its content would differ while its identity matched, and this fails — which is the
 * only thing that stops the checkpoint's identity-based change detection from losing the edit.
 */
function assertReplacedWhenChanged(before: Map<string, any>, after: any[], what: string) {
  const now = new Map(after.map((message: any) => [message.id, message]));
  for (const [id, was] of before) {
    const object = now.get(id);
    if (!object) continue;
    if (JSON.stringify(object) !== was.json) {
      assert.ok(object !== was.object, `${what}: ${id} changed, so it must be a new object, not an edit in place`);
    }
  }
}

test('every path that changes a message leaves a new object, never an edit in place', async () => {
  const h = harness();
  await h.connect(seed(1, 6, 40));
  await h.join(0);
  const list = () => h.messages() as any[];

  // A streamed upsert of a message already on the page: the same id arrives again with new text.
  let was = snapshotOf(list());
  h.event({ type: 'message.update', event_seq: 1, chat_id: 'general',
    message: { ...list()[2], text: 'streamed', updated_at: list()[2].updated_at + 1 } });
  await h.tick();
  assertReplacedWhenChanged(was, list(), 'a streamed upsert');
  assert.equal(list()[2].text, 'streamed', 'and the change really landed');

  // An edit, as the server sends one: a message.update carrying a new object.
  was = snapshotOf(list());
  h.event({ type: 'message.update', event_seq: 2, chat_id: 'general',
    message: { ...list()[2], text: 'edited', updated_at: list()[2].updated_at + 1 } });
  await h.tick();
  assertReplacedWhenChanged(was, list(), 'an edit');
  assert.equal(list()[2].text, 'edited');

  // A reaction, which arrives the same way and changes only the message's meta.
  was = snapshotOf(list());
  h.event({ type: 'message.update', event_seq: 3, chat_id: 'general',
    message: { ...list()[2], meta: { ...list()[2].meta, reaction: 'thumbs up' } } });
  await h.tick();
  assertReplacedWhenChanged(was, list(), 'a reaction');
  assert.equal(list()[2].meta.reaction, 'thumbs up');

  // The two status paths, each snapshotted while the row it mutates is still the live one. A send marks
  // its row pending, and a send that then fails rewrites that same row: if the snapshot is taken before
  // the send, the send's own replacement hides the mutation entirely, which is how a markFailed that
  // edited in place and a setLocalStatus that edited in place both went unnoticed. So each request is
  // held in flight, the live row is snapshotted, and only then is the request failed.
  h.setRequest(async () => { throw new ApiError('offline', 0); });
  await h.store.getState().sendMessage('s', 'general', 'a question');
  await h.tick();
  const queued = list().find((m: any) => m.status === 'queued');
  assert.ok(queued, 'a send with no network leaves the message queued');

  // A connection lost mid-send: the pending row goes back to queued, a change to a row that exists.
  let lose: (error: any) => void = () => {};
  h.setRequest(() => new Promise((_, reject) => { lose = reject; }));
  const lost = h.store.getState().sendMessage('s', 'general', 'a question', { retryClientId: queued.id });
  await h.tick();
  assert.equal(list().find((m: any) => m.id === queued.id).status, 'pending', 'the retry is on its way');
  was = snapshotOf(list());
  lose(new ApiError('the network dropped it', 0));
  await lost;
  await h.tick();
  assertReplacedWhenChanged(was, list(), 'a status change (setLocalStatus)');
  assert.equal(list().find((m: any) => m.id === queued.id).status, 'queued', 'and it is queued again');

  // A refusal: that same pending row is what markFailed rewrites, so the snapshot has to be taken now.
  let refuse: (error: any) => void = () => {};
  h.setRequest(() => new Promise((_, reject) => { refuse = reject; }));
  const refused = h.store.getState().sendMessage('s', 'general', 'a question', { retryClientId: queued.id });
  await h.tick();
  assert.equal(list().find((m: any) => m.id === queued.id).status, 'pending', 'the refused attempt is on its way');
  was = snapshotOf(list());
  refuse(new ApiError('the server refused it', 409));
  await refused;
  await h.tick();
  assertReplacedWhenChanged(was, list(), 'a failed mark (markFailed)');
  const failed = list().find((m: any) => m.id === queued.id);
  assert.equal(failed.status, 'failed', 'the retry was refused and the row says so');
  assert.equal(failed.meta.delivery_error, 'the server refused it');

  // A delete removes the message and leaves the survivors' objects alone.
  was = snapshotOf(list());
  const gone = list()[0];
  h.event({ type: 'message.delete', event_seq: 4, chat_id: 'general', message_id: gone.id });
  await h.tick();
  assert.equal(list().some((m: any) => m.id === gone.id), false, 'the deleted message is gone');
  assertReplacedWhenChanged(was, list(), 'a delete');

  // A resync snapshot, merged: it reuses the chat's page when nothing was removed, and filters it when
  // something was, so every survivor is still the same object rather than a copy.
  const before = list();
  const merged = h.merge.mergeSnapshot(h.store.getState().runtime.s, { scope: 'scope', server_id: 's',
    bot: 'Test', epoch: 'epoch', watermark: 4, chats: [chat('general')], inbox: [], pending: 0, paused: null,
    deletions: { general: [before[1].id] } });
  const survivors = merged.messages.general as any[];
  assert.equal(survivors.length, before.length - 1, 'the snapshot\'s deletion is applied');
  assert.ok(survivors.every((m: any) => before.includes(m)), 'and the survivors are the very objects, not copies');
  assertReplacedWhenChanged(snapshotOf(before), survivors, 'a snapshot merge');
});

test('a load adopts the chunk layout the meta names instead of re-cutting it', async () => {
  const cache = new Map<string, any>();
  const first = harness(cache);
  await first.connect(acrossBoundary(first, 300));
  await first.join(0);
  assert.equal(chunkKeys(first, 'general').length, 2, 'two chunks to start with');

  // An edit does not change the message count, so the layout the chat already had is kept. The text that
  // emptied makes a fresh greedy cut produce one chunk, so the disk is left holding a layout a re-cut
  // would not reproduce — exactly the edit-era layout a load must adopt rather than recompute.
  const edited = first.messages()[0];
  first.event({ type: 'message.update', event_seq: 1, chat_id: 'general',
    message: { ...edited, text: '', updated_at: edited.updated_at + 1 } });
  await first.tick();
  const chunks = Array.from(chunkKeys(first, 'general'));
  assert.deepEqual(chunks, ['replay:s:c:general:0', 'replay:s:c:general:1'], 'the kept layout survives the edit');

  const second = harness(cache);
  await second.connect();
  second.reset();
  await second.join(1);
  assert.deepEqual(Array.from(chunkKeys(second, 'general')), chunks,
    'the first save after the load names the same records, not a re-cut');
  assert.deepEqual(second.keys().filter((key) => key.includes(':c:')), [], 'and rewrites no chunk at all');

  // Deleting the chat must take every record it owns; a re-cut baseline would have forgotten one and left
  // a record holding deleted text on the disk until the next launch swept it.
  second.event({ type: 'chat.delete', event_seq: 2, chat_id: 'general' });
  await second.tick();
  assert.deepEqual(chunks.filter((key) => cache.has(key)), [], 'no orphan chunk is left holding deleted text');
});

test('a message bigger than the chunk target is its own chunk, and no chunk record is ever empty', async () => {
  const h = harness();
  // The guard the cut needs: a message heavier than the target must start a chunk, not close an empty
  // one. Without it the first record holds no messages, and a restore would carry a hole it cannot see.
  const history = { chats: { general: chat('general') }, messages: { general: [
    msg(0, { id: 'general-huge', text: 'x'.repeat(200000) }),
    msg(1, { id: 'general-after' }),
  ] } };
  const plan = h.checkpoint.planCheckpoint('s', checkpointState(history) as any,
    { scope: 'scope', epoch: 'epoch', cursor: 1 });
  const written = Array.from(plan.write as any[]).filter((item: any) => item.key.includes(':c:general:'));
  assert.deepEqual(written.map((item: any) => [item.key, item.value.messages.length]),
    [['replay:s:c:general:0', 1], ['replay:s:c:general:1', 1]], 'two records of one message each');
});

test('a very long chat raises its chunk size instead of its chunk count, and an append still writes the tail', async () => {
  const h = harness();
  // 30,000 messages of ~700 bytes: 21 MB, which at a fixed 64 KB target would be ~330 chunks.
  const messages = Array.from({ length: 30000 }, (_, i) => ({ id: `general-${i}`, position: i,
    chat_id: 'general', role: 'bot', text: 'x'.repeat(600), status: 'final', meta: {},
    created_at: 1, updated_at: i + 1 }));
  const slices = checkpointState({ chats: { general: chat('general') }, messages: { general: messages } } as any);
  const plan = h.checkpoint.planCheckpoint('s', slices, { scope: 'scope', epoch: 'epoch', cursor: 1 });
  const keys = Array.from(plan.saved.chats.general.keys as string[]);
  const total = messages.reduce((sum, message) => sum + weightOf(message), 0);
  assert.ok(keys.length > 100, `21 MB is ${keys.length} chunks, so the cap is doing the work`);
  assert.ok(keys.length <= h.checkpoint.MAX_CHUNKS,
    `${keys.length} chunks is within the cap of ${h.checkpoint.MAX_CHUNKS}`);

  // One append: every boundary but the tail's closed long ago and cannot move, so only the tail is walked
  // and only the tail record is sealed.
  const page = [...messages, { ...messages[0], id: 'general-live', position: messages.length, updated_at: 9000 }];
  const next = h.checkpoint.planCheckpoint('s', { ...slices, messages: { general: page } } as any,
    { scope: 'scope', epoch: 'epoch', cursor: 2 }, plan.saved);
  const sealed = Array.from(next.write as any[]).map((item: any) => item.key).filter((key: string) => key.includes(':c:'));
  assert.deepEqual(sealed, [keys[keys.length - 1]], 'only the tail chunk is written');
});

test('a chat grown by appends stops at the chunk cap, and the crossing recuts it exactly once', () => {
  const h = harness();
  const cursor = (n: number) => ({ scope: 'scope', epoch: 'epoch', cursor: n });
  // ~8 KiB of JSON per message, so eight fill a 64 KiB chunk and the cap is about 2,048 messages away:
  // the crossing is reached by ordinary appends rather than turned up on purpose.
  const page = (n: number) => ({ id: `general-${n}`, position: n, chat_id: 'general', role: 'bot',
    text: 'x'.repeat(8000), status: 'final', meta: {}, created_at: 1, updated_at: n + 1 });
  const base = { chats: { general: chat('general') }, deleted: {}, loaded: {}, inbox: {}, pending: 0, tasks: {} };
  let messages: any[] = [];
  let saved: any;
  let most = 0;
  const recuts: Array<{ chunks: number; wrote: number }> = [];

  /** One ordinary append: a new message, one save, and the chunk count it left on the disk. */
  const append = (n: number) => {
    messages = [...messages, page(n)];
    const plan = h.checkpoint.planCheckpoint('s', { ...base, messages: { general: messages } }, cursor(n + 1), saved);
    const chat_ = plan.saved.chats.general;
    const keys = Array.from(chat_.keys as string[]);
    assert.equal(chat_.marks.reduce((sum: number, mark: any) => sum + mark.n, 0), messages.length,
      `save ${n} laid out every message exactly once`);
    const wrote = Array.from(plan.write as any[]).map((item: any) => item.key)
      .filter((key: string) => key.includes(':c:general:'));
    most = Math.max(most, keys.length);
    if (wrote.length > 1) recuts.push({ chunks: keys.length, wrote: wrote.length });
    else assert.deepEqual(wrote, [keys[keys.length - 1]], `save ${n} rewrote no chunk but the tail`);
    saved = plan.saved;
    return keys.length;
  };

  // Grow the chat one message per save until the append that would go past the cap arrives.
  const counts: number[] = [];
  let n = 0;
  while (recuts.length === 0) {
    counts.push(append(n++));
    assert.ok(n < 4096, 'the chat reached the cap by appends');
  }

  // The save before the crossing sat exactly on the cap, and the crossing save recut the whole chat once
  // instead of adding a 257th chunk. One recut, not one per message.
  assert.equal(counts[counts.length - 2], h.checkpoint.MAX_CHUNKS, 'the chat was at the cap before the crossing');
  assert.equal(recuts.length, 1, 'exactly one whole-chat recut');
  assert.equal(recuts[0].wrote, recuts[0].chunks, 'and it rewrote every chunk of the chat, so it was a recut');
  assert.ok(recuts[0].chunks < h.checkpoint.MAX_CHUNKS,
    `the recut left ${recuts[0].chunks} chunks, inside the cap of ${h.checkpoint.MAX_CHUNKS}`);
  assert.equal(counts[counts.length - 1], recuts[0].chunks, 'that is the count the crossing save left behind');
  assert.ok(saved.chats.general.target > h.checkpoint.CHUNK_TARGET_BYTES,
    `the cap raised the target to ${saved.chats.general.target} bytes instead of adding chunks`);

  // Appends after the crossing are one chunk again, and nothing crosses the cap for a second time.
  for (let k = 0; k < 12; k++) {
    const count = append(n++);
    assert.ok(count <= h.checkpoint.MAX_CHUNKS, `save ${n} left ${count} chunks`);
  }
  assert.equal(recuts.length, 1, 'the appends after the crossing paid for no second recut');
  assert.ok(most <= h.checkpoint.MAX_CHUNKS,
    `no save left more than ${h.checkpoint.MAX_CHUNKS} chunks, and the most any left was ${most}`);
  assert.equal(saved.chats.general.marks.reduce((sum: number, mark: any) => sum + mark.n, 0), messages.length,
    'and every message is still laid out once, in order');
});

test('a load takes its recut threshold from the target the disk was cut at, not from the weight', async () => {
  const h = harness();
  // A chat the disk holds cut at 128 KiB: the size the append path is recut at when it reaches the cap,
  // while the chat's weight alone only justifies 64 KiB. A load that recomputed the target would disagree
  // with the records it had just read.
  const messages = Array.from({ length: 40 }, (_, i) => msg(i, { id: `adopt-${i}`, text: 'x'.repeat(1200) }));
  const chunks = Array.from({ length: 4 }, (_, index) => `replay:s:c:general:${index}`);
  const cache = new Map<string, any>();
  for (const [index, key] of chunks.entries()) {
    cache.set(key, { v: 3, messages: messages.slice(index * 10, index * 10 + 10) });
  }
  cache.set('replay:s:t:general', { v: 3, deleted: [] });
  cache.set('replay:s:v3', { v: 3, cursor: { scope: 'scope', epoch: 'epoch', cursor: 1 } });
  cache.set('replay:s:v3:meta', { v: 3, chats: { general: chat('general') }, loaded: {}, inbox: {}, pending: 0,
    tasks: {}, pages: ['general'], chunks: { general: chunks }, targets: { general: 128 * 1024 } });

  const loaded = await h.checkpoint.loadCheckpoint('s',
    async (key: string, fallback: any) => (cache.has(key) ? structuredClone(cache.get(key)) : fallback));
  assert.ok(loaded, 'the checkpoint loads');
  assert.equal(loaded.layout.general.target, 128 * 1024, 'the target came off the disk beside the keys');

  const refs = h.checkpoint.savedRefsOf('s', loaded.state, loaded.layout);
  assert.deepEqual(Array.from(refs.chats.general.keys as string[]), chunks, 'the same records, in order');
  assert.equal(refs.chats.general.target, 128 * 1024, 'and the same target to recut against');
  assert.equal(refs.meta.targets.general, 128 * 1024, 'recorded in the meta, so the next load has it too');

  // What a recomputation would have said, and why it matters: this chat still fits 64 KiB chunks by weight.
  const total = messages.reduce((sum, message) => sum + weightOf(message), 0);
  assert.ok(total < h.checkpoint.CHUNK_TARGET_BYTES * h.checkpoint.MAX_CHUNKS,
    `the weight alone (${total} bytes) still fits the 64 KiB target, so a recomputed target would be 65536`);
  const plan = h.checkpoint.planCheckpoint('s', loaded.state,
    { scope: 'scope', epoch: 'epoch', cursor: 2 }, refs);
  assert.deepEqual(Array.from(plan.write as any[]).map((item: any) => item.key), ['replay:s:v3'],
    'the first save after the load rewrites no chunk and leaves the meta alone');
});

test('a restore reads its chunk records a bounded number at a time', async () => {
  const h = harness();
  const cache = new Map<string, any>();
  // Twelve chats of five chunks each: without a bound the restore fans out over all twelve chats at once,
  // and a 100,000-message chat would do the same with 220 records.
  const ids = ['general', ...Array.from({ length: 11 }, (_, i) => `chat${i + 1}`)];
  const chunks: Record<string, string[]> = {};
  const chats: Record<string, any> = {};
  for (const id of ids) {
    chats[id] = chat(id);
    chunks[id] = Array.from({ length: 5 }, (_, i) => `replay:s:c:${id}:${i}`);
    for (const [i, key] of chunks[id].entries()) cache.set(key, { v: 3, messages: [msg(i, { id: `${id}-${i}` })] });
    cache.set(`replay:s:t:${id}`, { v: 3, deleted: [] });
  }
  cache.set('replay:s:v3', { v: 3, cursor: { scope: 'scope', epoch: 'epoch', cursor: 1 } });
  cache.set('replay:s:v3:meta', { v: 3, chats, loaded: {}, inbox: {}, pending: 0, tasks: {},
    pages: ids, chunks });

  let active = 0;
  let peak = 0;
  const loaded = await h.checkpoint.loadCheckpoint('s', async (key: string, fallback: any) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    const value = cache.has(key) ? structuredClone(cache.get(key)) : fallback;
    active -= 1;
    return value;
  });
  assert.equal(loaded.complete, true, 'all 60 records read');
  assert.equal(ids.reduce((n, id) => n + loaded.state.messages[id].length, 0), 60, 'every message came back');
  assert.ok(peak <= h.checkpoint.READ_CONCURRENCY,
    `${peak} reads were in flight over ${ids.length} chats, and the bound is ${h.checkpoint.READ_CONCURRENCY}`);

  // The same records, wider and resolving at once: this is the accounting, not the read. A slot taken only
  // after the wait is not counted while the woken caller is still queued, so readers that have been handed
  // a slot stack up on top of the ones already inside `run`. Sixty chats of five chunks expose it: the
  // bound is 8 and it peaked at 32 with the slot counted after the wait.
  const wide = Array.from({ length: 60 }, (_, i) => `wide${i}`);
  const wideChats: Record<string, any> = {};
  const wideChunks: Record<string, string[]> = {};
  for (const id of wide) {
    wideChats[id] = chat(id);
    wideChunks[id] = Array.from({ length: 5 }, (_, i) => `replay:s:c:${id}:${i}`);
    for (const [i, key] of wideChunks[id].entries()) cache.set(key, { v: 3, messages: [msg(i, { id: `${id}-${i}` })] });
    cache.set(`replay:s:t:${id}`, { v: 3, deleted: [] });
  }
  cache.set('replay:s:v3:meta', { v: 3, chats: wideChats, loaded: {}, inbox: {}, pending: 0, tasks: {},
    pages: wide, chunks: wideChunks });

  let fastActive = 0;
  let fastPeak = 0;
  const fast = await h.checkpoint.loadCheckpoint('s', async (key: string, fallback: any) => {
    fastActive += 1;
    fastPeak = Math.max(fastPeak, fastActive);
    await null;
    const value = cache.has(key) ? structuredClone(cache.get(key)) : fallback;
    fastActive -= 1;
    return value;
  });
  assert.equal(fast.complete, true, 'all 300 records read');
  assert.equal(wide.reduce((n, id) => n + fast.state.messages[id].length, 0), 300, 'every message came back');
  assert.ok(fastPeak <= h.checkpoint.READ_CONCURRENCY,
    `${fastPeak} instantly-resolving reads were in flight, and the bound is ${h.checkpoint.READ_CONCURRENCY}`);
});
