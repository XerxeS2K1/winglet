import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import vm from 'node:vm';
import { gcm } from '@noble/ciphers/aes.js';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

/**
 * What persistence writes while chats stream, measured with the real persist.ts on a simulated clock: 30 updates a second per
 * chat, 200 earlier messages in each. Counts are exact; the milliseconds are the real JSON.stringify + AES-GCM cost of those
 * writes on this machine (the same work cache.ts does on the JS thread before SQLite).
 * WINGLET_BENCH_PERSIST names another copy of persist.ts, so "before" and "after" come from this one test.
 */
const SOURCE = process.env.WINGLET_BENCH_PERSIST ?? new URL('../src/lib/persist.ts', import.meta.url);
const HISTORY = 200;
const RATE = 30;

const old = (i: number) => ({ id: `old${i}`, chat_id: 'c', role: i % 2 ? 'bot' : 'user', status: 'final', text: `An earlier message number ${i}, with a few words in it.`, meta: {}, created_at: i, updated_at: i });
const reply = (text: string, status: string, id = 'reply') => ({ id, chat_id: 'c', role: 'bot', status, text, meta: {}, created_at: 9999, updated_at: 9999 });

function harness(chatIds: string[]) {
  // Built once per chat, like the real store, which keeps earlier messages as the very same objects while a reply streams.
  const histories = Object.fromEntries(chatIds.map((c) => [c, Array.from({ length: HISTORY }, (_, i) => ({ ...old(i), chat_id: c }))]));
  const chatState = (text: string, status: string, extra: Record<string, any> = {}) => ({
    runtime: { s: {
      chats: Object.fromEntries(chatIds.map((c) => [c, { id: c }])), inbox: {}, loaded: Object.fromEntries(chatIds.map((c) => [c, true])),
      messages: Object.fromEntries(chatIds.map((c) => [c, [...histories[c], { ...reply(text, status), chat_id: c }]])), ...extra,
    } },
  });
  const store = createStore<any>(() => ({ drafts: {}, draftFiles: {}, replyTo: {}, runtime: {}, foreground: true, selection: {}, visibleChat: undefined }));
  const clock = { now: 1_000_000 };
  const timers = new Map<number, () => void>();
  const events = new Map<string, () => void>();
  const saved = new Map<string, any>();
  const log = { chatWrites: 0, messages: 0, bytes: 0, sealMs: 0, at: [] as number[] };
  const key = new Uint8Array(32), nonce = new Uint8Array(12);
  let next = 0;
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(SOURCE, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports,
    require: (id: string) => id === './store' ? { useApp: store } : {
      cacheSet: (k: string, value: any) => {
        const t0 = performance.now();
        const raw = JSON.stringify(value);
        gcm(key, nonce, new TextEncoder().encode(k)).encrypt(new TextEncoder().encode(raw));
        log.sealMs += performance.now() - t0;
        if (k.startsWith('msgs:')) { log.chatWrites++; log.messages += value.length; log.bytes += raw.length; log.at.push(clock.now); }
        saved.set(k, JSON.parse(raw));
      },
    },
    Date: { now: () => clock.now },
    setTimeout: (fn: () => void) => { timers.set(++next, fn); return next; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  });
  const detach = exports.attachPersistence();
  const tick = (ms = 1000) => { clock.now += ms; for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  // The server appears (not counted as an edit), then its chat is written once, as it is in the app before a reply streams.
  const seed = () => { store.setState(chatState('seed', 'final')); tick(0); store.setState(chatState('seed again', 'final')); tick(); for (const k of Object.keys(log)) (log as any)[k] = Array.isArray((log as any)[k]) ? [] : 0; saved.clear(); };
  /** The reply streams for `seconds`, 30 updates a second; the clock ticks once a second. Returns after the last update. */
  const stream = (seconds: number, text = (n: number) => `word ${n}`) => {
    for (let s = 0; s < seconds; s++) {
      for (let u = 0; u < RATE; u++) store.setState(chatState(text(s * RATE + u), 'streaming'));
      tick();
    }
  };
  return { store, chatState, clock, timers, events, saved, log, detach, tick, seed, stream, exports };
}
const savedText = (h: ReturnType<typeof harness>, chat = 'c') => h.saved.get(`msgs:s:${chat}`)?.at(-1)?.text;

for (const [label, chats, seconds] of [['one 20 s reply, 4 chats streaming', ['c1', 'c2', 'c3', 'c4'], 20], ['one 90 s reply, 1 chat', ['c'], 90]] as const) {
  test(`bench: ${label}`, () => {
    const h = harness([...chats]);
    h.seed();
    h.stream(seconds);
    const during = { ...h.log };
    h.store.setState(h.chatState('The whole reply.', 'final'));
    h.tick();
    const after = { ...h.log };
    console.log(`BENCH persist [${label}]: during the reply ${during.chatWrites} chat writes, ${during.messages} messages sealed, ${(during.bytes / 1024).toFixed(0)} KiB, ${during.sealMs.toFixed(0)} ms`
      + ` | after it ended ${after.chatWrites} chat writes in total | STREAMING_WRITE_MS=${h.exports.STREAMING_WRITE_MS}`);
    for (const c of chats) assert.equal(h.saved.get(`msgs:s:${c}`).at(-1).text, 'The whole reply.', 'the finished reply is on disk');
    h.detach();
  });
}

test('a killed app loses at most the bounded age of a streaming reply', () => {
  const h = harness(['c']);
  h.seed();
  const max = h.exports.STREAMING_WRITE_MS;
  assert.ok(max <= 30_000, `the hold is bounded at 30 s (it is ${max} ms)`);
  h.stream(70);
  // Nothing may have been written more than `max` + one tick apart while the reply streamed.
  const gaps = h.log.at.slice(1).map((t, i) => t - h.log.at[i]);
  assert.ok(Math.max(...gaps) <= max + 1000, `longest gap between writes ${Math.max(...gaps)} ms`);
  const lastWrite = h.log.at.at(-1)!;
  assert.ok(h.clock.now - lastWrite <= max + 1000, 'what is on disk is never older than the bound');
  h.detach();
});

test('finishing, failing and removing a streaming reply write the chat at the next tick, not after the hold', () => {
  const endings: [string, (h: ReturnType<typeof harness>) => void, (h: ReturnType<typeof harness>) => void][] = [
    ['finish', (h) => h.store.setState(h.chatState('The whole reply.', 'final')), (h) => assert.equal(savedText(h), 'The whole reply.')],
    ['error', (h) => h.store.setState(h.chatState('half', 'failed')), (h) => assert.equal(h.saved.get('msgs:s:c').length, HISTORY, 'a failed reply is not cached (cacheable), and the chat is written without it')],
    ['abort, reply removed', (h) => h.store.setState(h.chatState('x', 'final', { messages: { c: Array.from({ length: HISTORY }, (_, i) => old(i)) } })), (h) => assert.equal(h.saved.get('msgs:s:c').length, HISTORY)],
  ];
  for (const [name, end, check] of endings) {
    const h = harness(['c']);
    h.seed();
    h.stream(3);
    const writesBefore = h.log.chatWrites;
    end(h);
    h.tick();
    assert.equal(h.log.chatWrites, writesBefore + 1, `${name}: one write at the next tick`);
    check(h);
    assert.equal(h.timers.size, 0, `${name}: nothing left waiting`);
    h.detach();
  }
});

test('backgrounding, pagehide and detaching write a held streaming chat at once', () => {
  for (const how of ['background', 'pagehide', 'detach'] as const) {
    const h = harness(['c']);
    h.seed();
    h.stream(4);
    const held = savedText(h);
    h.store.setState(h.chatState('latest words', 'streaming'));
    assert.equal(savedText(h), held, `${how}: still held`);
    if (how === 'background') h.store.setState({ foreground: false });
    else if (how === 'pagehide') h.events.get('pagehide')!();
    else h.detach();
    assert.equal(savedText(h), 'latest words', how);
    h.detach();
  }
});

test('switching chat writes a held streaming chat at once', () => {
  for (const how of ['selection', 'visibleChat'] as const) {
    const h = harness(['c']);
    h.seed();
    h.stream(4);
    h.store.setState(h.chatState('latest words', 'streaming'));
    assert.notEqual(savedText(h), 'latest words', `${how}: still held before the switch`);
    h.store.setState(how === 'selection' ? { selection: { serverId: 's', chatId: 'other' } } : { visibleChat: { serverId: 's', chatId: 'other' } });
    assert.equal(savedText(h), 'latest words', `${how}: written at once`);
    h.detach();
  }
});

test('a chat switch with nothing held writes nothing', () => {
  const h = harness(['c']);
  h.seed();
  h.store.setState({ selection: { serverId: 's', chatId: 'other' } });
  h.store.setState({ visibleChat: { serverId: 's', chatId: 'c' } });
  assert.equal(h.log.chatWrites, 0);
  h.detach();
});

test('what is read back from the cache is identical to what was streamed', () => {
  const h = harness(['c']);
  h.seed();
  h.stream(40);
  h.store.setState(h.chatState('The whole reply.', 'final'));
  h.tick();
  const final = h.store.getState().runtime.s.messages.c;
  assert.deepEqual(h.saved.get('msgs:s:c'), JSON.parse(JSON.stringify(final.slice(-200))));
  h.detach();
});
