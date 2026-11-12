import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

function harness() {
  const store = createStore(() => ({ drafts: {}, draftFiles: {}, replyTo: {}, runtime: {}, foreground: true }));
  const saved = new Map<string, any>();
  const timers = new Map<number, () => void>();
  const events = new Map<string, () => void>();
  let next = 0;
  const clock = { now: 1_000_000 };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/persist.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (id: string) => id === './store' ? { useApp: store } : {
      cacheSet: (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    },
    Date: { now: () => clock.now },
    setTimeout: (fn: () => void) => { timers.set(++next, fn); return next; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  });
  const writes: string[] = [];
  const tick = (ms = 1000) => { clock.now += ms; for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { store, saved, timers, events, clock, tick, hold: exports.STREAMING_WRITE_MS as number, detach: exports.attachPersistence() };
}

test('backgrounding immediately saves the latest text, ready files and reply before the debounce', () => {
  const h = harness();
  const ready = { localId: 'file', status: 'ready', upload: { id: 'upload' } };
  h.store.setState({ drafts: { 'bot:chat': 'Unsent question' }, replyTo: { 'bot:chat': { id: 'reply', text: 'Context' } },
    draftFiles: { 'bot:chat': [ready, { status: 'uploading' }, { status: 'failed' }, { ...ready, autoSend: true }] } });
  assert.equal(h.saved.size, 0);
  h.store.setState({ foreground: false });
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Unsent question');
  assert.equal(h.saved.get('replyTo')['bot:chat'].id, 'reply');
  assert.deepEqual(h.saved.get('draftFiles')['bot:chat'], [ready]);
  assert.equal(h.timers.size, 0);
  h.detach();
});

test('browser pagehide and cleanup flush pending edits and detach all listeners and timers', () => {
  const h = harness();
  h.store.setState({ drafts: { 'bot:chat': 'First' } });
  h.events.get('pagehide')!();
  assert.equal(h.saved.get('drafts')['bot:chat'], 'First');
  h.store.setState({ drafts: { 'bot:chat': 'Latest' } });
  h.detach();
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Latest');
  assert.equal(h.events.size, 0);
  assert.equal(h.timers.size, 0);
  h.store.setState({ drafts: {} });
  assert.equal(h.timers.size, 0);
});

test('edits received while backgrounded are persisted without another visibility transition', () => {
  const h = harness();
  h.store.setState({ foreground: false });
  h.store.setState({ drafts: { 'bot:chat': 'Shared from another app' } });
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Shared from another app');
  assert.equal(h.timers.size, 0);
  h.detach();
});

// A chat streaming a reply changes ~30 times a second; sealing its 200 messages every second was the largest single cost
// on the JS thread while several chats streamed (see tests/streamBench.test.ts).
const chatState = (text: string, status: string, extra: any[] = []) => ({
  runtime: { s: { chats: { c: { id: 'c' } }, inbox: {}, loaded: { c: true },
    messages: { c: [...extra, { id: 'm', chat_id: 'c', role: 'bot', status, text, meta: {}, created_at: 1, updated_at: 1 }] } } },
});
/** A harness that already knows the server (a server's first appearance is not an edit), with nothing yet written. */
function seeded() {
  const h = harness();
  h.store.setState(chatState('seed', 'final'));
  h.tick(0);
  h.saved.clear();
  return h;
}
const savedText = (h: ReturnType<typeof harness>) => h.saved.get('msgs:s:c')?.at(-1)?.text;

test('a chat that is still streaming is written at most every STREAMING_WRITE_MS, and a finished reply at the next tick', () => {
  const h = seeded();
  h.store.setState(chatState('one', 'streaming'));
  h.tick();                                              // first write is never held
  assert.equal(savedText(h), 'one');
  for (let i = 2; i <= 4; i++) {
    h.store.setState(chatState(`word ${i}`, 'streaming'));
    h.tick();
    assert.equal(savedText(h), 'one', `held back at second ${i}`);   // no write while the reply streams
    assert.equal(h.timers.size, 1, 'and it is looked at again, not forgotten');
  }
  h.tick(h.hold - 3000);                                 // the hold is up (3 s of it passed in the three ticks above, this is the rest): due
  assert.equal(savedText(h), 'word 4');
  h.store.setState(chatState('word 5', 'streaming'));
  h.tick();
  assert.equal(savedText(h), 'word 4');
  h.store.setState(chatState('The whole reply.', 'final'));
  h.tick();                                              // the reply ended: written without waiting out the hold
  assert.equal(savedText(h), 'The whole reply.');
  assert.equal(h.timers.size, 0);
  h.detach();
});

test('the hold is 30 seconds, not the 5 it used to be: pinned by value and by behaviour, so reverting it fails', () => {
  const h = seeded();
  assert.equal(h.hold, 30_000, 'a decided figure (Kraig, 30 s): change this test only with that decision');
  h.store.setState(chatState('first', 'streaming'));
  h.tick();                                              // the first write is never held
  assert.equal(savedText(h), 'first');
  for (let s = 1; s < 30; s++) {                         // a new word every second for 29 s, far past the old 5 s
    h.store.setState(chatState(`second ${s}`, 'streaming'));
    h.tick();
    assert.equal(savedText(h), 'first', `still held ${s} s after the write`);
  }
  h.store.setState(chatState('second 30', 'streaming'));
  h.tick();                                              // 30 s after the write: due
  assert.equal(savedText(h), 'second 30');
  h.detach();
});

test('backgrounding, pagehide and detaching write a streaming chat at once', () => {
  for (const how of ['background', 'pagehide', 'detach'] as const) {
    const h = seeded();
    h.store.setState(chatState('one', 'streaming'));
    h.tick();
    h.store.setState(chatState('two', 'streaming'));
    h.tick();
    assert.equal(savedText(h), 'one', how);
    if (how === 'background') h.store.setState({ foreground: false });
    else if (how === 'pagehide') h.events.get('pagehide')!();
    else h.detach();
    assert.equal(savedText(h), 'two', how);
    h.detach();
  }
});

test('a streamed edit while backgrounded is written immediately, not held', () => {
  const h = seeded();
  h.store.setState(chatState('one', 'streaming'));
  h.tick();
  h.store.setState({ foreground: false });
  h.store.setState(chatState('two', 'streaming'));
  assert.equal(savedText(h), 'two');
  h.detach();
});

test('a chat switch writes at once only while something is held: with nothing held, pending edits still wait for the tick', () => {
  for (const how of ['selection', 'visibleChat'] as const) {
    const switchChat = (h: ReturnType<typeof harness>) =>
      h.store.setState(how === 'selection' ? { selection: { serverId: 's', chatId: 'other' } } : { visibleChat: { serverId: 's', chatId: 'other' } });
    // Nothing held: a draft is waiting for the one-second tick, and a switch must not cut that short.
    const idle = seeded();
    idle.store.setState({ drafts: { 'bot:chat': 'typed' } });
    switchChat(idle);
    assert.equal(idle.saved.get('drafts'), undefined, `${how}: not written by a switch while nothing is held`);
    assert.equal(idle.timers.size, 1, `${how}: still waiting for its tick`);
    idle.tick();
    assert.equal(idle.saved.get('drafts')['bot:chat'], 'typed', `${how}: written at the tick`);
    idle.detach();
    // Something held: the same switch writes everything pending at once.
    const busy = seeded();
    busy.store.setState(chatState('one', 'streaming'));
    busy.tick();
    busy.store.setState({ ...chatState('two', 'streaming'), drafts: { 'bot:chat': 'typed' } });
    busy.tick();
    assert.equal(savedText(busy), 'one', `${how}: held`);
    busy.store.setState({ drafts: { 'bot:chat': 'typed more' } });
    switchChat(busy);
    assert.equal(busy.saved.get('drafts')['bot:chat'], 'typed more', `${how}: written at once while a reply is held`);
    assert.equal(savedText(busy), 'two', `${how}: and so is the held reply`);
    busy.detach();
  }
});

test('holding a streaming chat back does not hold back drafts or other chats', () => {
  const h = seeded();
  h.store.setState(chatState('one', 'streaming'));
  h.tick();
  h.store.setState({ ...chatState('two', 'streaming'), drafts: { 'bot:chat': 'typed' } });
  h.tick();
  assert.equal(h.saved.get('drafts')['bot:chat'], 'typed');
  assert.equal(savedText(h), 'one');
  h.detach();
});

const earlier = (id: string, text: string) => ({ id, chat_id: 'c', role: 'user', status: 'final', text, meta: {}, created_at: 1, updated_at: 1 });
const savedList = (h: ReturnType<typeof harness>) => (h.saved.get('msgs:s:c') ?? []).map((m: any) => `${m.id}:${m.text}`);

test('a change to an earlier message is not held back just because the last one is streaming', () => {
  const a = earlier('a', 'first'), b = earlier('b', 'second'), edited = earlier('b', 'second, edited');
  const h = seeded();
  h.store.setState(chatState('one', 'streaming', [a, b]));
  h.tick();
  h.store.setState(chatState('two', 'streaming', [a, b]));
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'b:second', 'm:one'], 'only the streaming reply changed: held');
  h.store.setState(chatState('two', 'streaming', [a, edited]));
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'b:second, edited', 'm:two'], 'an earlier message was edited: written at the next tick');
  h.store.setState(chatState('three', 'streaming', [a, edited]));
  h.tick();
  assert.equal(savedText(h), 'two', 'back to held (the earlier messages are the same objects as at the last write)');
  h.store.setState(chatState('three', 'streaming', [a]));
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'm:three'], 'an earlier message was deleted: written at the next tick');
  h.detach();
});

test('a new message, or a different last message, is written at the next tick while the reply streams', () => {
  const a = earlier('a', 'first');
  const h = seeded();
  h.store.setState(chatState('one', 'streaming', [a]));
  h.tick();
  h.store.setState(chatState('two', 'streaming', [a, earlier('b', 'a question')]));
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'b:a question', 'm:two'], 'a message was added');
  h.store.setState({ runtime: { s: { ...h.store.getState().runtime.s, messages: { c: [a, { ...earlier('n', 'other reply'), role: 'bot', status: 'streaming' }] } } } });
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'n:other reply'], 'the last message is another message');
  h.store.setState({ runtime: { s: { ...h.store.getState().runtime.s, messages: { c: [a, { ...earlier('x', 'swapped in'), role: 'bot', status: 'streaming' }] } } } });
  h.tick();
  assert.deepEqual(savedList(h), ['a:first', 'x:swapped in'], 'a different last message of the same count is written too');
  h.detach();
});

test('a new reply that starts streaming right after a finished one is held like any streaming reply (one write per finished reply, not per second)', () => {
  const done = { ...earlier('d', 'Done.'), role: 'bot' };
  const h = seeded();
  h.store.setState(chatState('one', 'streaming', [done]));
  h.tick();
  h.store.setState(chatState('The whole reply.', 'final', [done]));
  h.tick();
  assert.equal(savedText(h), 'The whole reply.');
  const finished = h.store.getState().runtime.s.messages.c.slice();
  const next = { ...earlier('n', 'next'), role: 'bot', status: 'streaming' };
  h.store.setState({ runtime: { s: { ...h.store.getState().runtime.s, messages: { c: [...finished, next] } } } });
  h.tick();
  assert.equal(savedText(h), 'The whole reply.', 'a new streaming reply, nothing earlier changed: held');
  h.tick(h.hold);
  assert.equal(savedText(h), 'next', 'and written once the hold is up');
  h.detach();
});

test('what is remembered about a streaming chat goes when the chat does', () => {
  const h = seeded();
  h.store.setState(chatState('one', 'streaming'));
  h.tick();
  h.store.setState({ runtime: { s: { ...h.store.getState().runtime.s, chats: {}, messages: {} } } });   // the chat is deleted (its list of chats changes, so a flush runs)
  h.tick();
  h.saved.clear();
  h.store.setState(chatState('one', 'streaming'));      // the same chat comes back, inside the hold
  h.tick();
  assert.equal(savedText(h), 'one', 'an old entry would have held this back as "unchanged"');
  h.detach();
});
