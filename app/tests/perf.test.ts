import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

type Env = { flag?: string; dev?: boolean };

function load(env: Env = {}) {
  const exports: any = {};
  const logs: string[] = [];
  const state = { now: 1000, frames: new Map<number, (t: number) => void>(), next: 1, timers: [] as (() => void)[], cancelled: 0 };
  const sandbox: any = {
    exports,
    process: { env: env.flag === undefined ? {} : { EXPO_PUBLIC_WINGLET_PERF: env.flag } },
    performance: { now: () => state.now },
    console: { log: (...a: unknown[]) => { logs.push(a.join(' ')); } },
    requestAnimationFrame: (cb: (t: number) => void) => { state.frames.set(state.next, cb); return state.next++; },
    cancelAnimationFrame: (id: number) => { state.cancelled += 1; state.frames.delete(id); },
    setTimeout: (cb: () => void) => state.timers.push(cb),
    clearTimeout: () => {},
  };
  if (env.dev !== undefined) sandbox.__DEV__ = env.dev;
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/perf.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  // Runs every queued animation frame callback once, advancing the fake clock by `step` first.
  const frame = (step: number) => { state.now += step; const run = [...state.frames.values()]; state.frames.clear(); run.forEach((cb) => cb(state.now)); };
  return { perf: exports, logs, state, frame };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('the switch is on in development, off in release, and the flag overrides both', () => {
  const { perf } = load();
  assert.equal(perf.perfSwitch(true, undefined), true);
  assert.equal(perf.perfSwitch(false, undefined), false);
  assert.equal(perf.perfSwitch(undefined, undefined), false);
  assert.equal(perf.perfSwitch(false, '1'), true);
  assert.equal(perf.perfSwitch(true, '0'), false);
  assert.equal(perf.perfSwitch(false, 'yes'), false, 'only "1" turns it on in a release build');
});

test('a reply is timed from send to first text and to the last streamed update', () => {
  const { perf } = load();
  const timer = new perf.ReplyTimer();
  timer.sent('chat', 0);
  assert.deepEqual(plain(timer.observe('chat', { id: 'tool', streaming: false, hasText: false }, 300)), {}, 'a tool bubble is not the reply');
  assert.deepEqual(plain(timer.observe('chat', { id: 'a', streaming: true, hasText: true }, 800)), { first: 800 });
  assert.deepEqual(plain(timer.observe('chat', { id: 'a', streaming: true, hasText: true }, 1200)), {});
  assert.deepEqual(plain(timer.observe('chat', { id: 'other', streaming: false, hasText: true }, 1500)), {}, 'a second message does not move the timing');
  const end = timer.observe('chat', { id: 'a', streaming: false, hasText: true }, 2100);
  assert.deepEqual(plain(end), { done: { firstTextMs: 800, totalMs: 2100, streamMs: 1300, updates: 3 } });
  assert.equal(timer.size, 0);
  assert.deepEqual(plain(timer.observe('chat', { id: 'b', streaming: false, hasText: true }, 9000)), {}, 'nothing is pending after the reply');
});

test('a reply that arrives whole reports first text and finish together; chats do not mix', () => {
  const { perf } = load();
  const timer = new perf.ReplyTimer();
  timer.sent('one', 100);
  timer.sent('two', 150);
  const step = timer.observe('one', { id: 'x', streaming: false, hasText: true }, 600);
  assert.equal(step.first, 500);
  assert.deepEqual(plain(step.done), { firstTextMs: 500, totalMs: 500, streamMs: 0, updates: 1 });
  assert.equal(timer.size, 1, 'the other chat is still waiting');
  timer.sent('two', 1000);
  assert.equal(timer.observe('two', { id: 'y', streaming: false, hasText: true }, 1200).first, 200, 'a second send restarts the clock');
});

test('frames later than 32 ms after the one before are counted as slow', () => {
  const { perf } = load();
  const meter = new perf.FrameMeter();
  for (const t of [0, 16, 32, 64, 112, 128, 232]) meter.tick(t);
  // gaps: 16, 16, 32 (not slow, exactly the limit), 48 (slow), 16, 104 (slow)
  assert.deepEqual(plain(meter.summary()), { frames: 6, slow: 2, worstMs: 104, spanMs: 232 });
  assert.deepEqual(plain(new perf.FrameMeter().summary()), { frames: 0, slow: 0, worstMs: 0, spanMs: 0 });
});

test('the frame loop is told to run only while something is streaming', () => {
  const { perf } = load();
  const gate = new perf.StreamingGate();
  assert.equal(gate.update('a', false), null);
  assert.equal(gate.update('a', true), 'start');
  assert.equal(gate.update('b', true), null);
  assert.equal(gate.update('a', false), null, 'one is still streaming');
  assert.equal(gate.update('b', false), 'stop');
  assert.equal(gate.update('c', true), 'start');
  assert.equal(gate.clear(), true);
  assert.equal(gate.clear(), false);
});

test('release builds do nothing: no clock, no frame loop, no output', () => {
  const { perf, logs, state } = load({ dev: false });
  assert.equal(perf.PERF_ON, false);
  perf.perfMessageSent('c');
  perf.perfMessageUpdate('c', { id: 'a', streaming: true, hasText: true });
  perf.perfFirstContent('chat list');
  assert.equal(state.frames.size, 0);
  assert.equal(state.timers.length, 0);
  assert.deepEqual(logs, []);
});

test('with the flag on, a streamed reply logs its timing and its dropped frames, and stops the loop', () => {
  const { perf, logs, state, frame } = load({ dev: false, flag: '1' });
  assert.equal(perf.PERF_ON, true);
  perf.perfMessageSent('c');
  state.now += 700;
  perf.perfMessageUpdate('c', { id: 'a', streaming: true, hasText: true });
  assert.equal(state.frames.size, 1, 'the frame loop started with the streaming message');
  frame(16); frame(16); frame(80); frame(16); // one slow gap among four frames
  state.now += 100;
  perf.perfMessageUpdate('c', { id: 'a', streaming: false, hasText: true });
  assert.equal(state.cancelled, 1);
  assert.deepEqual(logs.map((l) => l.replace('[winglet-perf] ', '')), [
    'reply: first text 700 ms after send',
    'reply: finished 928 ms after send (first text 700 ms, streaming 228 ms, 2 updates)',
    'frames while streaming: 1 slow (> 32 ms) of 3 over 112 ms, worst gap 80 ms',
  ]);
  frame(16);
  assert.equal(state.frames.size, 0, 'no frame is requested after the reply finished');
});

test('replayed updates are ignored and a stuck stream stops watching frames', () => {
  const { perf, logs, state } = load({ dev: false, flag: '1' });
  perf.perfMessageSent('c');
  perf.perfMessageUpdate('c', { id: 'a', streaming: true, hasText: true }, true);
  assert.deepEqual(logs, []);
  assert.equal(state.frames.size, 0);
  perf.perfMessageUpdate('c', { id: 'a', streaming: true, hasText: true });
  assert.equal(state.timers.length, 1);
  state.timers[0]();
  assert.match(logs[logs.length - 1], /frames while streaming/);
});

test('the first content paint is logged once per launch', () => {
  const { perf, logs, state, frame } = load({ dev: false, flag: '1' });
  state.now += 450;
  perf.perfFirstContent('chat list');
  perf.perfFirstContent('message list');
  frame(0); frame(30);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cold start: chat list painted 480 ms after the JS bundle began/);
});

test('the hooks are in place and cost nothing when off', () => {
  const store = readFileSync(new URL('../src/lib/store.ts', import.meta.url), 'utf8');
  assert.match(store, /perfMessageSent\(`\$\{serverId\}:\$\{chatId\}`\)/);
  assert.match(store, /perfMessageUpdate\(/);
  assert.match(readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8'), /perfFirstContent\('message list'\)/);
  assert.match(readFileSync(new URL('../src/app/(tabs)/chats.tsx', import.meta.url), 'utf8'), /perfFirstContent\('chat list'\)/);
  // Nothing here may send data anywhere.
  const perf = readFileSync(new URL('../src/lib/perf.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(perf, /fetch\(|XMLHttpRequest|WebSocket|from '\.\/api'|signedApi/);
});
