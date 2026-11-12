import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';
import { gcm } from '@noble/ciphers/aes.js';

/**
 * A benchmark that is also a test: four chats of 300 messages each, every one with a reply streaming in at 30 updates a
 * second, through the real store (`message.new` / `message.update` events), the real persistence module and the real
 * message helpers. No device. It prints a table of time, garbage-collector work and counted operations per update, and
 * asserts only on COUNTED operations (deterministic) so it never fails because a machine is slow.
 *
 * What is real and what is not:
 *  - real: store.ts (handleEvent, upsertMessage), persist.ts (subscribe + flush), messages.ts (mergeMessages, groupActivity).
 *  - real crypto cost: the cache stub does what cache.ts does before SQLite, JSON.stringify then AES-GCM (@noble/ciphers).
 *  - not real: SQLite writes, React rendering, FlatList layout, markdown parsing. Those are not measured here.
 *  - the row builder below is a verbatim copy of the useMemo in ChatView.tsx's MessageList unless noted otherwise.
 */

const CHATS = ['c1', 'c2', 'c3', 'c4'];
const HISTORY = 300;
const SECONDS = 20;
const PER_SECOND = 30;

function compile(file: string, imports: Record<string, any>, globals: Record<string, any> = {}) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require: (id: string) => {
      if (id in imports) return imports[id];
      throw new Error(`Unexpected import ${id}`);
    }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, ...globals,
  });
  return exports;
}

class Gc {
  count = 0; pauseMs = 0;
  private observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) { this.count++; this.pauseMs += e.duration; } });
  start() { this.count = 0; this.pauseMs = 0; this.observer.observe({ entryTypes: ['gc'] }); }
  async stop() { await new Promise((r) => setTimeout(r, 20)); this.observer.disconnect(); }
}

type Counters = { listCopied: number; rowsBuilt: number; flushedMessages: number; flushedBytes: number; flushes: number; flushedChats: number };

function build(options: { persist: boolean }) {
  const counters: Counters = { listCopied: 0, rowsBuilt: 0, flushedMessages: 0, flushedBytes: 0, flushes: 0, flushedChats: 0 };
  let request: (...args: any[]) => Promise<any> = async () => ({ messages: [], deleted_ids: [] });
  let socket: any;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const clock = { now: 1_700_200_000_000 }; // the simulated wall clock: persist.ts decides by Date.now()
  const vmTimers = { setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => 0, clearInterval: () => {} };
  class FakeSocket {
    readyState = 1;
    onmessage?: (event: any) => void;
    constructor() { socket = this; }
    send() {}
    close() {}
  }
  class ApiError extends Error { status = 0; data: any; }
  class FakeCoordinator { join() {} leave() {} async want() {} satisfied() {} setForeground() {} setOnline() {} retryNow() {} }
  const helpers = compile('../src/lib/messages.ts', {});
  const key = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(1);
  const cache = {
    cacheGet: async (_: string, fallback: any) => fallback,
    cacheSetStrict: async () => {},
    cacheRemove: async () => {},
    // What cache.ts does on the JS thread before the SQLite write: stringify, then seal.
    cacheSet: (k: string, value: unknown) => {
      const raw = JSON.stringify(value);
      counters.flushedBytes += raw.length;
      if (k.startsWith('msgs:')) { counters.flushedChats++; counters.flushedMessages += (value as any[]).length; }
      gcm(key, nonce, new TextEncoder().encode(k)).encrypt(new TextEncoder().encode(raw));
    },
  };
  const { useApp: store } = compile('../src/lib/store.ts', {
    zustand: { create: (fn: any) => createStore(fn) },
    'zustand/react/shallow': { useShallow: (fn: any) => fn },
    'react-native': { Platform: { OS: 'android' } },
    './recovery': { RecoveryCoordinator: FakeCoordinator },
    '../features/phone-tools/runtime': { phoneHello() {}, phoneEvent() {}, phoneDisconnect() {}, phoneVisibility() {} },
    './messages': helpers,
    './commands': { needsSignature: () => false },
    '../features/projects/logic': compile('../src/features/projects/logic.ts', {}),
    '../features/event-replay/session': compile('../src/features/event-replay/session.ts', { './protocol': compile('../src/features/event-replay/protocol.ts', {}) }),
    '../features/event-replay/merge': compile('../src/features/event-replay/merge.ts', {}),
    './api': { api: (...args: any[]) => request(...args), ApiError, wsUrl: (s: any) => s.url, signedApi: (...a: any[]) => request(...a) },
    './cache': cache,
    './verify': { NEEDS_VERIFY: 'Verify this phone to do that.' },
    './network': { refreshNetworkNow: async () => {} },
    './authCheck': { ...compile('../src/lib/authCheck.ts', {}), AUTH_RECHECK_DELAYS_MS: [1, 1], pause: async () => {} },
    './handledNotifications': compile('../src/lib/handledNotifications.ts', {}),
    './perf': { PERF_ON: false, perfMessageSent() {}, perfMessageUpdate() {} },
    '../features/encrypted-push/native': { pushNative: { clear() {} } },
    '../features/execution/model': compile('../src/features/execution/model.ts', {}),
    './sounds': { sound: { reply() {}, needsYou() {}, tap() {}, sent() {} } },
    './storage': { getJSON: async (_: string, fallback: any) => fallback, setJSON: async () => {} },
  }, { WebSocket: FakeSocket, ...vmTimers });
  const persist = options.persist
    ? compile('../src/lib/persist.ts', { './cache': cache, './store': { useApp: store } }, { ...vmTimers, Date: { now: () => clock.now } }).attachPersistence()
    : () => {};
  return { store, helpers, counters, timers, clock, setRequest: (fn: typeof request) => { request = fn; }, socket: () => socket, persist,
    event: (data: any) => socket.onmessage?.({ data: JSON.stringify(data) }) };
}

const WORDS = 'the quick brown fox jumps over a lazy dog while streaming a long and fairly ordinary chat reply with `code` and **bold** text'.split(' ');
const para = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + seed) % WORDS.length]).join(' ');
/** History: every third message is the user's, the rest are bot replies of 300-900 characters. */
const history = (chat: string, n: number) => Array.from({ length: n }, (_, i) => ({
  id: `${chat}-h${i}`, position: i + 1, chat_id: chat, role: i % 3 === 0 ? 'user' : 'bot', status: 'final', meta: {},
  text: para(i % 3 === 0 ? 8 : 50 + (i % 9) * 15, i), created_at: 1_700_000_000 + i * 60, updated_at: 1_700_000_000 + i * 60,
}));

/** The row builder from ChatView's MessageList, as it was (one copy for the "before" numbers). */
function buildRows(helpers: any, messages: any[], typing: boolean, seen: Set<string> | null) {
  const GROUP_WINDOW_S = 7 * 60;
  const notice = (m: any) => (m.role === 'bot' && m.status === 'final' && m.text.length < 200 && /^(?:⏳|⚡|⏱|⚠)/u.test(m.text.trim()) ? m.text : null);
  const dayKey = (ts: number) => { const d = new Date(ts * 1000); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const sameGroup = (a: any, b: any) => !(!a || !b || a.role !== b.role || a.role === 'system' || b.role === 'system' || notice(a) || notice(b))
    && Math.abs(b.created_at - a.created_at) < GROUP_WINDOW_S;
  const out: any[] = [];
  const entries = helpers.groupActivity(messages, typing);
  const idOf = (e: any) => (e.kind === 'msg' ? e.m.id : e.id);
  const timeOf = (e: any) => (e.kind === 'msg' ? e.m.created_at : e.items[0].created_at);
  const days = entries.map((e: any) => dayKey(timeOf(e)));
  let lastSeen = -1;
  if (seen) entries.forEach((e: any, i: number) => { if (seen.has(idOf(e))) lastSeen = i; });
  const grouped = (a: any, b: any) => a?.kind === 'msg' && b?.kind === 'msg' && sameGroup(a.m, b.m);
  entries.forEach((e: any, i: number) => {
    if (days[i] !== days[i - 1]) out.push({ kind: 'day', key: `day-${days[i]}-${idOf(e)}` });
    if (e.kind === 'activity') { out.push({ kind: 'activity', key: `activity-${e.id}`, items: e.items }); return; }
    out.push({ kind: 'msg', key: e.m.id, m: e.m, first: !grouped(entries[i - 1], e), last: !grouped(e, entries[i + 1]),
      live: typing && i === entries.length - 1, fresh: !!seen && i > lastSeen });
  });
  return out.reverse();
}

type Row = { phase: string; total: number; updates: number; gcCount: number; gcMs: number; note?: string };

/** `turn`: updates per reply. 60 = a reply streams for two seconds then the next starts; 600 = one long reply for the whole run. */
async function run(options: { persist: boolean; rows: boolean; turn: number }) {
  const TURN_UPDATES = options.turn;
  const h = build({ persist: options.persist });
  await h.store.getState().addServer({ id: 's', url: 'http://test', token: 't', deviceId: 'd', bot: { title: 'Test' } });
  h.store.getState().setVisibleChat({ serverId: 's', chatId: 'c1' });
  h.event({ type: 'hello', chats: CHATS.map((id) => ({ id, kind: 'chat', title: id })), pending: 0 });
  await new Promise((r) => setImmediate(r));
  for (const chat of CHATS) {
    h.setRequest(async () => ({ messages: history(chat, HISTORY), deleted_ids: [] }));
    await h.store.getState().loadMessages('s', chat);
  }
  const cs = () => h.store.getState().runtime.s.messages;
  assert.equal(cs().c1.length, HISTORY);

  let created = 1_700_100_000;
  const stream = (chat: string, turn: number, step: number) => {
    const id = `${chat}-live${turn}`;
    const text = para(10 + step * 3, turn);
    created += 1;
    const done = step === TURN_UPDATES - 1;
    return { type: step === 0 ? 'message.new' : 'message.update', chat_id: chat, message: {
      id, position: HISTORY + 10 + turn, chat_id: chat, role: 'bot', status: done ? 'final' : 'streaming', meta: {}, text,
      created_at: 1_700_050_000 + turn * 120, updated_at: created } };
  };

  const gc = new Gc();
  const total = SECONDS * PER_SECOND;
  let eventMs = 0, rowMs = 0, flushMs = 0, events = 0;
  const seen = new Set((cs().c1 ?? []).map((m: any) => m.id));
  gc.start();
  for (let sec = 0; sec < SECONDS; sec++) {
    for (let k = 0; k < PER_SECOND; k++) {
      const n = sec * PER_SECOND + k;
      const turn = Math.floor(n / TURN_UPDATES);
      const step = n % TURN_UPDATES;
      for (const chat of CHATS) {
        const ev = stream(chat, turn, step);
        h.counters.listCopied += cs()[chat].length;
        const a = performance.now();
        h.event(ev);
        eventMs += performance.now() - a;
        events++;
        if (options.rows && chat === 'c1') {
          const b = performance.now();
          const rows = buildRows(h.helpers, cs().c1, true, seen);
          rowMs += performance.now() - b;
          h.counters.rowsBuilt += rows.length;
        }
      }
    }
    // One second has passed: the one-second persistence timer fires.
    h.clock.now += 1000;
    const f = performance.now();
    for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); }
    flushMs += performance.now() - f;
    h.counters.flushes++;
  }
  await gc.stop();
  h.persist();
  return { events, total, eventMs, rowMs, flushMs, gc, counters: h.counters, finalLength: cs().c1.length, h };
}

for (const turn of [60, 600]) {
  test(`stream benchmark: 4 chats x 300 messages, 30 updates a second into each, ${turn === 60 ? '2 s replies' : 'one 20 s reply'}`, async () => {
    const bare = await run({ persist: false, rows: false, turn });
    const withPersist = await run({ persist: true, rows: true, turn });
    const c = withPersist.counters;
    const per = (ms: number, n: number) => (n ? `${((ms * 1000) / n).toFixed(1)} us` : '-');
    console.log([
      '',
      `streamBench [${turn === 60 ? '2 s replies' : 'one 20 s reply'}]: ${CHATS.length} chats x ${HISTORY} messages, ${PER_SECOND} updates/s into each for ${SECONDS}s = ${withPersist.events} updates`,
      `  upsert via handleEvent, no persistence : ${bare.eventMs.toFixed(0)} ms total, ${per(bare.eventMs, bare.events)} per update, gc ${bare.gc.count} runs / ${bare.gc.pauseMs.toFixed(0)} ms`,
      `  upsert via handleEvent + persist listener: ${withPersist.eventMs.toFixed(0)} ms total, ${per(withPersist.eventMs, withPersist.events)} per update`,
      `  row building (visible chat only)         : ${withPersist.rowMs.toFixed(0)} ms total, ${per(withPersist.rowMs, withPersist.events / CHATS.length)} per build, ${(c.rowsBuilt / (withPersist.events / CHATS.length)).toFixed(0)} rows per build`,
      `  persist flush (stringify + AES-GCM)      : ${withPersist.flushMs.toFixed(0)} ms total, ${(withPersist.flushMs / SECONDS).toFixed(1)} ms per flush (once a second), ${(c.flushedChats / c.flushes).toFixed(1)} chats / ${(c.flushedMessages / c.flushes).toFixed(0)} messages / ${(c.flushedBytes / c.flushes / 1024).toFixed(0)} KiB per flush`,
      `  list entries copied per update (upsert)  : ${(c.listCopied / withPersist.events).toFixed(0)}`,
      `  chat length at the end                   : ${withPersist.finalLength} (started at ${HISTORY})`,
    ].join('\n'));
    assert.equal(withPersist.finalLength, HISTORY + Math.ceil(SECONDS * PER_SECOND / turn));
  });
}
