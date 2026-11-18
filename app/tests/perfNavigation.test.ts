import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

type Env = { flag?: string; dev?: boolean };

// Same loader as perf.test.ts: perf.ts compiled and run in a sandbox with a fake clock and a fake frame queue.
function load(env: Env = {}) {
  const exports: any = {};
  const logs: string[] = [];
  const state = { now: 1000, frames: new Map<number, (t: number) => void>(), next: 1 };
  const sandbox: any = {
    exports,
    process: { env: env.flag === undefined ? {} : { EXPO_PUBLIC_WINGLET_PERF: env.flag } },
    performance: { now: () => state.now },
    console: { log: (...a: unknown[]) => { logs.push(a.join(' ')); } },
    requestAnimationFrame: (cb: (t: number) => void) => { state.frames.set(state.next, cb); return state.next++; },
    cancelAnimationFrame: (id: number) => { state.frames.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  if (env.dev !== undefined) sandbox.__DEV__ = env.dev;
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/perf.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  const frame = (step: number) => { state.now += step; const run = [...state.frames.values()]; state.frames.clear(); run.forEach((cb) => cb(state.now)); };
  return { perf: exports, logs, state, frame };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const lines = (logs: string[]) => logs.map((l) => l.replace('[winglet-perf] ', ''));
const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('a chat switch gives the first commit once, then the populated one, from the same start', () => {
  const { perf } = load();
  const marks = new perf.NavMarks();
  marks.start('chat', 'a:1', 100);
  marks.start('chat', 'a:1', 130); // the route opening after the tap: the tap's time stands
  assert.equal(marks.step('chat', 'a:1', 180), 80);
  assert.equal(marks.step('chat', 'a:1', 190), null, 'the first commit is reported once');
  assert.equal(marks.finish('chat', 'a:1', 400), 300);
  assert.equal(marks.finish('chat', 'a:1', 500), null, 'a start is used up');
  assert.equal(marks.size, 0);
});

test('a commit for another chat or screen is not this start\'s commit, and an old start is dropped', () => {
  const { perf } = load();
  const marks = new perf.NavMarks();
  marks.start('chat', 'a:1', 0);
  assert.equal(marks.step('chat', 'a:2', 50), null);
  assert.equal(marks.finish('screen', 'a:1', 50), null, 'kinds do not mix');
  marks.start('chat', 'a:1', 20_000 - 5); // a repeat after the first went stale starts again
  assert.equal(marks.finish('chat', 'a:1', 20_000), 5);
  marks.start('screen', 'inbox', 0);
  assert.equal(marks.finish('screen', 'inbox', perf.NAV_STALE_MS + 1), null, 'a tap that went nowhere is forgotten');
});

test('the sidebar takes the newest start, since closing is also called when nothing is open', () => {
  const { perf } = load();
  const marks = new perf.NavMarks();
  marks.start('drawer-close', '', 0);
  marks.start('drawer-close', '', 3000);
  assert.equal(marks.finish('drawer-close', '', 3040), 40);
});

test('a screen is named by its first path segment only, so ids never reach the log', () => {
  const { perf } = load();
  assert.equal(perf.routeLabel('/'), 'home');
  assert.equal(perf.routeLabel(''), 'home');
  assert.equal(perf.routeLabel('/chat/bot-1/chat-9?x=1'), 'chat');
  assert.equal(perf.routeLabel('/inbox'), 'inbox');
  assert.equal(perf.routeLabel('/(tabs)/chats'), '?', 'anything but a plain word is not printed');
  assert.equal(perf.routeLabel('/Secret_Name'), '?');
});

test('the sidebar frame watch counts slow frames for its time only, then stops', () => {
  const { perf } = load();
  const watch = new perf.TimedFrameWatch(700);
  const ran = [0, 16, 32, 80, 96, 700, 716].map((t) => watch.tick(t));
  assert.deepEqual(ran, [true, true, true, true, true, true, false], 'the frame after the time is up is refused');
  assert.deepEqual(plain(watch.summary()), { frames: 5, slow: 2, worstMs: 604, spanMs: 700 });
});

test('the navigation lines read the same way every time', () => {
  const { perf } = load();
  assert.equal(perf.chatSwitchCommittedLine(84.4), 'chat switch: message list committed 84 ms after navigation began');
  assert.equal(perf.chatSwitchPopulatedLine(412), 'chat switch: message list fully populated 412 ms after navigation began');
  assert.equal(perf.drawerLine('open', 31), 'sidebar: open committed 31 ms after the tap');
  assert.equal(perf.drawerLine('close', 9), 'sidebar: close committed 9 ms after the tap');
  assert.equal(perf.drawerFrameLine({ frames: 40, slow: 3, worstMs: 71, spanMs: 690 }), 'frames while sidebar opens: 3 slow (> 32 ms) of 40 over 690 ms, worst gap 71 ms');
  assert.equal(perf.screenChangeLine('inbox', 120), 'screen change: inbox committed 120 ms after navigation began');
});

test('chat switch marks are taken at the commit, not when a frame runs', () => {
  const { perf, logs, state } = load({ dev: false, flag: '1' });
  perf.perfNavStart('chat', 'a:1');
  state.now += 60;
  perf.perfChatCommitted('a:1');
  state.now += 200;
  perf.perfChatPopulated('a:1');
  assert.deepEqual(lines(logs), [
    'chat switch: message list committed 60 ms after navigation began',
    'chat switch: message list fully populated 260 ms after navigation began',
  ]);
  assert.equal(state.frames.size, 0, 'no frame callback is involved');
});

test('the sidebar logs its open at the commit and then the slow frames of the opening, without waiting on a frame for the mark', () => {
  const { perf, logs, state, frame } = load({ dev: false, flag: '1' });
  perf.perfNavStart('drawer-open');
  state.now += 25;
  perf.perfDrawerCommitted(true);
  assert.deepEqual(lines(logs), ['sidebar: open committed 25 ms after the tap'], 'logged before any frame has run');
  frame(0); frame(16); frame(70); frame(16);
  frame(1000); // the time is up
  assert.deepEqual(lines(logs).slice(1), ['frames while sidebar opens: 1 slow (> 32 ms) of 3 over 102 ms, worst gap 70 ms']);
  assert.equal(state.frames.size, 0, 'the watch ends');
  perf.perfNavStart('drawer-close');
  state.now += 12;
  perf.perfDrawerCommitted(false);
  assert.equal(lines(logs).at(-1), 'sidebar: close committed 12 ms after the tap');
  assert.equal(state.frames.size, 0, 'closing starts no watch');
});

test('a screen change is logged when its path commits, by name only', () => {
  const { perf, logs, state } = load({ dev: false, flag: '1' });
  perf.perfNavStart('screen', 'chat');
  state.now += 140;
  perf.perfScreenCommitted('/chat/bot-1/chat-9');
  perf.perfScreenCommitted('/chat/bot-1/chat-9');
  perf.perfScreenCommitted('/inbox');
  assert.deepEqual(lines(logs), ['screen change: chat committed 140 ms after navigation began'], 'once; a commit nobody started logs nothing');
  assert.ok(!logs.join('\n').includes('bot-1'));
});

test('release builds do nothing for navigation: no clock, no frame, no output, nothing pending', () => {
  const { perf, logs, state } = load({ dev: false });
  assert.equal(perf.PERF_ON, false);
  perf.perfNavStart('chat', 'a:1');
  perf.perfChatCommitted('a:1');
  perf.perfChatPopulated('a:1');
  perf.perfNavStart('drawer-open');
  perf.perfDrawerCommitted(true);
  perf.perfNavStart('screen', 'inbox');
  perf.perfScreenCommitted('/inbox');
  assert.equal(state.frames.size, 0);
  assert.deepEqual(logs, []);
});

test('the navigation hooks are in place, each behind the switch', () => {
  const nav = src('components/AppNavigation.tsx');
  assert.match(nav, /perfNavStart\('drawer-open'\)/);
  assert.match(nav, /perfNavStart\('drawer-close'\)/);
  assert.match(nav, /perfDrawerCommitted\(visible\)/);
  assert.match(nav, /perfScreenCommitted\(pathname\)/);
  assert.match(nav, /perfNavStart\('chat', `\$\{bot\.id\}:\$\{chat\.id\}`\)/);
  assert.match(src('components/ChatView.tsx'), /perfChatCommitted\(navKey\)/);
  assert.match(src('components/ChatView.tsx'), /perfChatPopulated\(navKey\)/);
  // The server's copy arriving must redraw the list even when it changes no message, so the flag is a subscription, not a read.
  assert.match(src('components/ChatView.tsx'), /const serverCopy = useApp\(\(st\) => PERF_ON && !!st\.runtime\[server\.id\]\?\.loaded\[chatId\]\)/);
  assert.match(src('app/(tabs)/chats.tsx'), /perfNavStart\('chat', `\$\{server\.id\}:\$\{id\}`\)/);
  assert.match(src('app/chat/[serverId]/[chatId].tsx'), /perfNavStart\('chat', started\.current\)/);
  // Every call into the marks from a component sits under PERF_ON, so a release build runs none of it.
  for (const file of ['components/AppNavigation.tsx', 'components/ChatView.tsx', 'app/(tabs)/chats.tsx', 'app/chat/[serverId]/[chatId].tsx']) {
    const all = src(file).split('\n');
    all.forEach((line, i) => {
      if (!/perf(NavStart|ChatCommitted|ChatPopulated|DrawerCommitted|ScreenCommitted)\(/.test(line) || /^import /.test(line)) return;
      // On its own line or in the block the line above opens (the `if (PERF_ON ...) {` right before it).
      assert.ok(/PERF_ON/.test(line) || /PERF_ON/.test(all[i - 1] + all[i - 2]), `${file}: ${line.trim()}`);
    });
  }
  // Nothing here may send data anywhere.
  assert.doesNotMatch(src('lib/perf.ts'), /fetch\(|XMLHttpRequest|WebSocket|from '\.\/api'|signedApi/);
});
