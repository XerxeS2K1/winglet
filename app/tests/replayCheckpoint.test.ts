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

type Write = { key: string; bytes: number };

const msg = (n: number, over: any = {}) => ({ id: `m${n}`, position: n, chat_id: 'general', role: 'bot',
  text: String(n), status: 'final', meta: {}, created_at: 1, updated_at: n, ...over });

const chat = (id: string) => ({ id, kind: 'chat', title: id });

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
  const timers: (() => void)[] = [];
  const frames: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const played: string[] = [];
  const cache = shared ?? new Map<string, any>();
  const writes: Write[] = [];
  const failOn = new Set<string>();
  class FakeSocket {
    readyState = 1;
    sent: any[] = [];
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    constructor() { socket = this; }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
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
      WebSocket: FakeSocket, setTimeout: (fn: () => void) => { timers.push(fn); return 0; }, clearTimeout: () => {},
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
  const checkpoint = compile('../src/features/event-replay/checkpoint.ts', {});
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
    '../features/event-replay/session': replaySession,
    '../features/event-replay/merge': compile('../src/features/event-replay/merge.ts', {}),
    '../features/event-replay/checkpoint': checkpoint,
    './api': { api: (...args: any[]) => request(...args), ApiError, wsUrl: (s: any) => s.url,
      signedApi: (...args: any[]) => request(...args) },
    './cache': {
      cacheGet: async (key: string, fallback: any) => (cache.has(key) ? structuredClone(cache.get(key)) : fallback),
      cacheSetStrict: async (key: string, value: any) => {
        if (failOn.has(key)) throw new Error(`storage full: ${key}`);
        writes.push({ key, bytes: JSON.stringify(value).length });
        cache.set(key, structuredClone(value));
      },
      cacheSet: async (key: string, value: any) => { cache.set(key, structuredClone(value)); },
      cacheRemove: async (prefix: string) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); },
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
    store, cache, writes, failOn, played, checkpoint, tick,
    socket: () => socket,
    event: (data: any) => socket.event(data),
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

test('a save writes the chat that changed and the cursor, and the cursor goes last', async () => {
  const h = harness();
  await h.connect(seed(4, 20, 40));
  await h.join(0);
  assert.equal(h.phase(), 'idle');
  h.reset();

  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:m:general', 'replay:s:v2'], 'one chat and the cursor, nothing else');
  assert.ok(h.cache.get('replay:s:m:general').messages.some((m: any) => m.id === 'm1'));
  assert.equal(h.cache.get('replay:s:v2').cursor.cursor, 1);
  assert.equal(h.cache.get('replay:s:m:chat2').messages.length, 20, 'an untouched chat is still there from the first save');

  h.reset();
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'chat2', message: { ...msg(2), id: 'chat2-x', chat_id: 'chat2' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:m:chat2', 'replay:s:v2'], 'only the chat that changed is rewritten');
});

test("a save where a new chat's page appears rewrites meta with the new id", async () => {
  const h = harness();
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  assert.deepEqual([...h.cache.get('replay:s:meta').pages].sort(), ['chat1', 'chat2', 'general'],
    'the first save named every page it wrote');
  h.reset();

  // A message for a chat this phone has not held before: its page record is new, so meta must name it too.
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'fresh', message: { ...msg(1), id: 'fresh-1', chat_id: 'fresh' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:m:fresh', 'replay:s:meta', 'replay:s:v2'],
    'the new page, then a meta that names it, then the cursor');
  assert.deepEqual([...h.cache.get('replay:s:meta').pages].sort(), ['chat1', 'chat2', 'fresh', 'general'],
    'a restore reads the new page back because meta names it');
});

test('a save where only a meta slice changed rewrites meta and no page', async () => {
  const h = harness();
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  h.reset();

  // Renaming a chat changes the chat list and nothing else: no page's messages moved.
  h.event({ type: 'chat.update', event_seq: 1, chat_id: 'general', chat: { ...chat('general'), title: 'Renamed' } });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:meta', 'replay:s:v2'], 'meta again, but no page record is rewritten');
  assert.equal(h.cache.get('replay:s:meta').chats.general.title, 'Renamed',
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
  assert.match((h.cache.get('replay:s:m:general').messages.find((m: any) => m.id === 'm900') ?? {}).text ?? '',
    /^y{400}20$/, 'the last token of the burst is on disk');
});

test('per-event written bytes stay small however large the history is', async () => {
  const h = harness();
  await h.connect(seed(10, 300, 500));
  await h.join(0);
  const whole = wholeStateBytes(h);
  assert.ok(whole > 1_000_000, `a megabyte-plus history (${whole} bytes)`);
  h.reset();
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  const perEvent = h.bytes();
  assert.ok(perEvent < 250_000, `one event wrote ${perEvent} bytes`);
  assert.ok(perEvent < whole / 5, `${perEvent} bytes is under a fifth of the ${whole}-byte whole state`);
  assert.deepEqual(h.keys(), ['replay:s:m:general', 'replay:s:v2']);
});

test('a crash between the data write and the cursor write leaves the cursor behind its data', async () => {
  const cache = new Map<string, any>();
  const h = harness(cache);
  await h.connect(seed(3, 20, 40));
  await h.join(0);
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.equal(h.cache.get('replay:s:v2').cursor.cursor, 1);

  // The next save's chat record lands, then the process dies before the cursor record can be written.
  h.failOn.add('replay:s:v2');
  h.reset();
  h.event({ type: 'message.new', event_seq: 2, chat_id: 'general', message: msg(2) });
  await h.tick();
  assert.deepEqual(h.keys(), ['replay:s:m:general'], 'the data was written, the cursor was not');
  assert.equal(h.cache.get('replay:s:v2').cursor.cursor, 1, 'the durable cursor is still behind the data');
  assert.ok(h.cache.get('replay:s:m:general').messages.some((m: any) => m.id === 'm2'));
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
  assert.equal(restarted.cache.get('replay:s:v2').cursor.cursor, 2, 'the cursor caught up');
});

test('a failed strict write is reported, and no cursor is written for a save that failed', async () => {
  const h = harness();
  await h.connect(seed(2, 10, 40));
  await h.join(0);
  h.failOn.add('replay:s:m:general');
  h.reset();
  h.event({ type: 'message.new', event_seq: 1, chat_id: 'general', message: msg(1) });
  await h.tick();
  assert.equal(h.phase(), 'blocked');
  assert.equal(h.cache.get('replay:s:v2').cursor.cursor, 0, 'no cursor was written for a save that failed');
  assert.deepEqual(h.keys(), [], 'and nothing followed the failed write');
  assert.ok(h.messages().some((m: any) => m.id === 'm1'),
    'the applied message is in memory; the next successful save persists it before any cursor');
});

test('nothing applied is left only in memory at rest, after a background or a dropped connection', async () => {
  const cache = new Map<string, any>();
  const h = harness(cache);
  await h.connect(seed(2, 10, 40));
  await h.join(0);

  const durable = () => (cache.get('replay:s:m:general')?.messages ?? []).map((m: any) => m.id).join();
  const shown = () => h.messages().map((m: any) => m.id).join();

  h.event({ type: 'message.update', event_seq: 1, chat_id: 'general', message: msg(50, { status: 'streaming', text: 'hello' }) });
  await h.tick();
  assert.equal(durable(), shown(), 'a streamed token is on disk once the frame ends');

  h.event({ type: 'message.update', event_seq: 2, chat_id: 'general', message: msg(50, { status: 'streaming', text: 'hello there' }) });
  await h.tick();
  h.store.getState().setForeground(false);
  await h.tick();
  assert.equal(durable(), shown(), 'going to the background leaves nothing unsaved');

  h.event({ type: 'message.new', event_seq: 3, chat_id: 'general', message: msg(51) });
  await h.tick();
  h.event({ type: 'message.update', event_seq: 4, chat_id: 'general', message: msg(51, { status: 'final', text: 'done' }) });
  await h.tick();
  const atDrop = shown();
  h.socket().readyState = 3; h.socket().onclose?.({ code: 1006 });
  await h.tick();
  h.store.getState().setForeground(true);
  await h.tick();
  assert.equal(durable(), atDrop, 'a dropped connection loses nothing that arrived before it');
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
  cache.set('replay:s:v2', { v: 2, cursor: { scope: 'scope', epoch: 'epoch', cursor: 0 } });
  const second = harness(cache);
  await second.connect();
  await second.begin(5);
  await second.reply(5, 5, events);
  const rt = second.store.getState().runtime.s;
  const task = rt.tasks.general ? { ...rt.tasks.general, updated_at: 0 } : undefined;
  assert.equal(JSON.stringify([rt.messages, rt.deleted, rt.chats, task]), after,
    're-applying the page changed nothing');
  assert.equal(second.cache.get('replay:s:v2').cursor.cursor, 5);
});

// ---------------------------------------------------------------------------------------------
// The session on its own: coalescing and failure propagation, with the host stubbed.

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
    }, setTimeout: (fn: () => void) => { return 0; }, clearTimeout: () => {},
  });
  return exports;
};

function host(options: { failWrites?: boolean; start?: number; snapshot?: any } = {}) {
  const fail = { on: options.failWrites === true };
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
    view: () => {},
    disconnect: () => {},
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
