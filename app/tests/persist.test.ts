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

test('a streamed edit while backgrounded is written immediately, not held', () => {
  const h = seeded();
  h.store.setState(chatState('one', 'streaming'));
  h.tick();
  h.store.setState({ foreground: false });
  h.store.setState(chatState('two', 'streaming'));
  assert.equal(savedText(h), 'two');
  h.detach();
});

const earlier = (id: string, text: string) => ({ id, chat_id: 'c', role: 'user', status: 'final', text, meta: {}, created_at: 1, updated_at: 1 });
const savedList = (h: ReturnType<typeof harness>) => (h.saved.get('msgs:s:c') ?? []).map((m: any) => `${m.id}:${m.text}`);

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

test('the streaming hold is one second (Kraig, 2026-11-12): a streaming chat is written at every tick, nothing is held back', () => {
  const h = seeded();
  assert.equal(h.hold, 1000, 'a decided figure: change this test only with that decision');
  h.store.setState(chatState('one', 'streaming'));
  h.tick();
  assert.equal(savedText(h), 'one');
  for (let i = 2; i <= 5; i++) {
    h.store.setState(chatState(`word ${i}`, 'streaming'));
    h.tick();
    assert.equal(savedText(h), `word ${i}`, `written at second ${i}`);
  }
  h.detach();
});

// Issue 48: the cache keeps a streaming reply as it is; the app finishes it and marks it when it is restored (restoredFromCache).
test('a reply that is streaming is written to the cache as streaming, unchanged', () => {
  const h = seeded();
  h.store.setState(chatState('half an answ', 'streaming'));
  h.tick();
  const last = h.saved.get('msgs:s:c').at(-1);
  assert.equal(last.status, 'streaming');
  assert.equal(last.text, 'half an answ');
  assert.equal('incomplete' in last.meta, false);
  h.detach();
});
