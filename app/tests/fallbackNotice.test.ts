import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createStore } from 'zustand/vanilla';
import ts from 'typescript';

/** Compile a production module as it is and give it only the imports the test names. */
function compile(file: string, modules: Record<string, any> = {}, globals: Record<string, any> = {}) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, ...globals,
    require: (id: string) => { if (id in modules) return modules[id]; throw new Error(`Unexpected import ${id}`); },
  });
  return exports;
}

const modelOptions = compile('../src/lib/modelOptions.ts');
const notice = compile('../src/lib/fallbackNotice.ts', { './modelOptions': modelOptions });
const { formatCountdown, remainingSeconds, stripText, stripLines, isFallbackActive, isTicking, snapshotOf } = notice;

test('countdown text rounds up and uses seconds, minutes, then hours', () => {
  const cases: [any, string][] = [
    [0, 'next message'], [1, '1 s'], [45, '45 s'], [59, '59 s'], [59.2, '1 min'],
    [60, '1 min'], [61, '2 min'], [719, '12 min'], [3599, '1 h'], [3600, '1 h'], [3601, '1 h 1 min'],
    [6912, '1 h 56 min'], [14400, '4 h'], [14401, '4 h 1 min'],
    [null, 'next message'], [undefined, 'next message'], [-5, 'next message'], [NaN, 'next message'],
    [Infinity, 'next message'], ['6912', 'next message'],
  ];
  for (const [input, expected] of cases) assert.equal(formatCountdown(input), expected, String(input));
});

test('remaining time comes from the arrival time on an injected monotonic clock', () => {
  assert.equal(remainingSeconds(6912, 1000, 1000), 6912);
  assert.equal(remainingSeconds(6912, 1000, 31000), 6882); // +30 s
  assert.equal(remainingSeconds(6912, 1000, 1000 + 6912_000), 0); // at expiry
  assert.equal(remainingSeconds(6912, 1000, 1000 + 7000_000), -88); // after expiry
  assert.equal(remainingSeconds(6912, 5000, 1000), 6912); // a clock that appears to go back never adds time
  assert.equal(remainingSeconds(null, 0, 99999), null);
  assert.equal(remainingSeconds(undefined, 0, 99999), null);
  assert.equal(remainingSeconds('9' as any, 0, 0), null);
  assert.equal(remainingSeconds(NaN, 0, 0), null);
  const at = (now: number) => formatCountdown(remainingSeconds(6912, 1000, now));
  assert.equal(at(1000), '1 h 56 min');
  assert.equal(at(31000), '1 h 55 min');
  assert.equal(at(1000 + 6912_000), 'next message');
  assert.equal(at(1000 + 9999_000), 'next message');
});

const rate = { active: true, reason: 'rate limit', retry_in_s: 6912, from_model: 'claude-sonnet-5-5', from_provider: 'anthropic' };
const snap = (fallback: any, model = 'reflection/beam-1.0-501b-a23b:free', arrivedAt = 1000) => snapshotOf({ model, fallback }, arrivedAt);

test('strip text for a rate limit shows the reason, the countdown and the model in use', () => {
  const text = stripText(snap(rate), 1000);
  assert.deepEqual({ ...text }, { title: 'Fallback · rate limit', countdown: '1 h 56 min', detail: 'Using beam 1.0 501b a23b:free' });
  assert.equal(stripText(snap(rate), 1000 + 6912_000).countdown, 'next message');
});

test('without a cooldown the strip says the next message and names what is tried again', () => {
  const text = stripText(snap({ active: true, reason: 'authentication failed', retry_in_s: null, from_model: 'claude-sonnet-5-5' }, 'claude-haiku-5-5'), 5000);
  assert.equal(text.title, 'Fallback · authentication failed');
  assert.equal(text.countdown, 'next message');
  assert.equal(text.detail, 'Using Claude Haiku 5.5 · Claude is tried again when you send');
  const unknown = stripText(snap({ active: true, reason: 'request timeout' }, 'x-1'), 0);
  assert.equal(unknown.countdown, 'next message');
  assert.equal(unknown.detail, 'Using x 1 · The main model is tried again when you send');
});

test('an empty or untidy reason never leaves a dangling separator', () => {
  assert.equal(stripText(snap({ active: true, reason: '', retry_in_s: 60 }), 1000).title, 'Fallback');
  assert.equal(stripText(snap({ active: true, retry_in_s: 60 }), 1000).title, 'Fallback');
  assert.equal(stripText(snap({ active: true, reason: '  \n\t ', retry_in_s: 60 }), 1000).title, 'Fallback');
  assert.equal(stripText(snap({ active: true, reason: 'rate\n  limit', retry_in_s: 60 }), 1000).title, 'Fallback · rate limit');
  const long = 'provider overloaded after many retries '.repeat(10);
  const title = stripText(snap({ active: true, reason: long, retry_in_s: 60 }), 1000).title;
  assert.ok(title.startsWith('Fallback · provider overloaded') && !/\n/.test(title)); // one line; the view truncates it
});

test('long model ids stay one line of text and an unknown model hides the second line', () => {
  for (const id of ['reflection/beam-1.0-501b-a23b:free', 'nvidia/nemotron-3-ultra-500b-a50b-reasoning']) {
    const detail = stripText(snap(rate, id), 1000).detail;
    assert.ok(detail.startsWith('Using ') && !/\n/.test(detail), detail);
  }
  assert.equal(stripText(snap(rate, 'nvidia/nemotron-3-ultra-500b-a50b-reasoning'), 1000).detail, 'Using nemotron 3 ultra 500b a50b reasoning');
  assert.equal(stripText(snap(rate, ''), 1000).detail, null);
});

test('only an explicit active fallback shows anything; an old server or a missing key shows nothing', () => {
  assert.equal(isFallbackActive(rate), true);
  for (const value of [undefined, null, {}, { active: false }, { active: 'true' }, { active: 1 }, 'x', []]) {
    assert.equal(isFallbackActive(value), false, JSON.stringify(value));
    assert.equal(snapshotOf({ model: 'm', fallback: value }, 0), null);
  }
  assert.equal(snapshotOf(null, 0), null);
  assert.equal(snapshotOf(undefined, 0), null);
  assert.equal(snapshotOf({ model: 'm' }, 0), null); // /api/agent from a server that predates the field
  assert.equal(stripText(null, 0), null);
});

test('the second line is dropped while the keyboard is open or the window is short', () => {
  assert.equal(stripLines(false, 800), 2);
  assert.equal(stripLines(true, 800), 1);
  assert.equal(stripLines(false, 559), 1);
  assert.equal(stripLines(false, 560), 2);
  assert.equal(stripLines(false, 0), 1);
  assert.equal(stripLines(false, NaN), 2); // an unknown size is not a reason to hide detail
});

test('the clock only ticks while a countdown is still running', () => {
  assert.equal(isTicking(snap(rate), 1000), true);
  assert.equal(isTicking(snap(rate), 1000 + 6911_000), true);
  assert.equal(isTicking(snap(rate), 1000 + 6912_000), false);
  assert.equal(isTicking(snap({ active: true, reason: 'x', retry_in_s: null }), 1000), false);
  assert.equal(isTicking(null, 0), false);
});

test('the shared slot is keyed per chat, replaced by the newest answer, and cleared when the fallback ends', () => {
  const store = compile('../src/lib/fallbackStore.ts', { zustand: { create: (fn: any) => createStore(fn) }, './fallbackNotice': notice });
  const state = () => store.useFallback.getState();
  assert.equal(state().slots['s:a'], undefined);
  state().publish('s:a', { model: 'beam', fallback: rate }, 100);
  state().publish('s:b', { model: 'claude', fallback: undefined }, 100); // not on a fallback: nothing stored
  assert.equal(state().slots['s:a'].model, 'beam');
  assert.equal(state().slots['s:a'].arrivedAt, 100);
  assert.equal(state().slots['s:b'], undefined);
  state().publish('s:a', { model: 'claude', fallback: undefined }, 200); // back on Claude: strip just goes away
  assert.equal(state().slots['s:a'], undefined);
  state().publish('s:a', { model: 'beam', fallback: rate }, 300);
  state().clear('s:a');
  assert.equal(state().slots['s:a'], undefined);
});

// -- the model button: one fetch, shared with the strip, dot only on the composer chip ------------------

function harness(info: any) {
  const effects: (() => any)[] = [];
  const states: any[] = [];
  let cursor = 0;
  const cleanups: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const fetches: string[] = [];
  let clock = 5000;
  const store = compile('../src/lib/fallbackStore.ts', { zustand: { create: (fn: any) => createStore(fn) }, './fallbackNotice': notice });
  const modules: Record<string, any> = {
    react: {
      useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (next: any) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      useEffect: (fn: any) => { effects.push(fn); }, useCallback: (fn: any) => fn, useRef: (v: any) => ({ current: v }),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Keyboard: { dismiss: () => undefined }, Text: 'Text', View: 'View', useWindowDimensions: () => ({ height: 800 }) },
    'react-native-gesture-handler': { ScrollView: 'ScrollView' },
    '../lib/actions': { sendHidden: () => undefined },
    '../lib/api': { api: (_server: any, path: string) => { fetches.push(path); return Promise.resolve(info); } },
    '../lib/haptics': { haptic: {} },
    '../lib/modelOptions': modelOptions,
    '../lib/modelSheet': { useModelSheet: Object.assign(() => undefined, { getState: () => ({ clear: () => undefined }) }) },
    '../lib/fallbackNotice': { ...notice, monotonicNow: () => clock },
    '../lib/fallbackStore': store,
    '../lib/store': { isOwner: () => true, useApp: (select: any) => select({ runtime: { s: { status: 'online', info: { features: { agent: true, pickers: true } }, messages: {} } } }) },
    '../lib/themeContext': { makeStyles: () => () => new Proxy({}, { get: (_t, key) => String(key) }), useTheme: () => ({ colors: { textSecondary: '#999', pressed: '#111', warning: '#F59E0B' } }) },
    '../lib/types': {},
    './icons': { Brain: 'Brain', ChevronDown: 'ChevronDown', ChevronLeft: 'ChevronLeft', Cpu: 'Cpu' },
    './PickerCard': { PickerCard: 'PickerCard' },
    './Sheet': { Sheet: 'Sheet' },
    './ui': { Button: 'Button', Chip: 'Chip', Skeleton: 'Skeleton', Tap: 'Tap' },
  };
  const exports = compile('../src/components/ModelSheet.tsx', modules);
  const render = (variant: 'header' | 'compact' | 'composer', chatId = 'a') => {
    cursor = 0; effects.length = 0;
    const tree = exports.ModelButton({ server: { id: 's' }, chatId, variant });
    for (const run of effects) { const cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup); }
    return tree;
  };
  const dotOf = (tree: any) => JSON.stringify(tree).includes('fallbackDot');
  return { render, fetches, store, dotOf, tick: (ms: number) => { clock += ms; }, unmount: () => { for (const c of cleanups.splice(0)) c(); } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const onFallback = { configured: { model: 'claude-sonnet-5-5' }, chat: { model: 'reflection/beam-1.0-501b-a23b:free', provider: 'nous', source: 'last_turn', fallback: rate } };
const onClaude = { configured: { model: 'claude-sonnet-5-5' }, chat: { model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'last_turn' } };

test('the composer chip fetches once, shares the answer with the strip and shows the amber dot', async () => {
  const h = harness(onFallback);
  h.render('composer');
  await settle();
  assert.deepEqual(h.fetches, ['/api/agent?chat=a']); // the strip adds no request of its own
  const slot = h.store.useFallback.getState().slots['s:a'];
  assert.equal(slot.model, 'reflection/beam-1.0-501b-a23b:free');
  assert.equal(slot.fallback.reason, 'rate limit');
  assert.equal(slot.arrivedAt, 5000);
  h.tick(30_000);
  assert.equal(h.dotOf(h.render('composer')), true);
});

test('the dot and the shared slot follow the data: nothing for Claude, and no "back on Claude" message', async () => {
  const h = harness(onClaude);
  await h.render('composer');
  await settle();
  assert.equal(h.store.useFallback.getState().slots['s:a'], undefined);
  assert.equal(h.dotOf(h.render('composer')), false);
});

test('other chips never publish the shared slot or draw the dot, and leaving the chat clears the slot', async () => {
  const h = harness(onFallback);
  for (const variant of ['header', 'compact'] as const) {
    h.render(variant);
    await settle();
    assert.equal(h.store.useFallback.getState().slots['s:a'], undefined, variant);
    assert.equal(h.dotOf(h.render(variant)), false, variant);
  }
  h.render('composer');
  await settle();
  assert.ok(h.store.useFallback.getState().slots['s:a']);
  h.unmount();
  assert.equal(h.store.useFallback.getState().slots['s:a'], undefined);
});

test('tapping the strip opens the same model sheet as tapping the composer chip, and only the composer chip answers', async () => {
  const h = harness(onFallback);
  assert.equal(h.store.openModelSheet('s:a'), false); // no chip yet: the strip's tap does nothing
  h.render('header');
  assert.equal(h.store.openModelSheet('s:a'), false); // other chips never register
  h.render('composer');
  assert.equal(h.store.openModelSheet('s:a'), true);
  const after = h.render('composer');
  assert.equal(after.props.children[1].props.visible, true);
  h.unmount();
  assert.equal(h.store.openModelSheet('s:a'), false); // gone with the chip
});

// -- wiring and guards ------------------------------------------------------------------------------

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('the strip sits at the top of the message box, opens the model sheet and keeps the countdown from shrinking', () => {
  const composer = read('../src/components/Composer.tsx');
  assert.match(composer, /<FallbackStrip server=\{server\} chatId=\{chatId\} \/>/);
  assert.ok(composer.indexOf('<FallbackStrip') < composer.indexOf('{replyTo ? ('), 'above the reply bar and the text box');
  const strip = read('../src/components/FallbackStrip.tsx');
  assert.match(strip, /flexShrink: 0/);
  assert.match(strip, /numberOfLines=\{1\}/);
  assert.match(strip, /openModelSheet|useModelSheet|onPress/);
  assert.doesNotMatch(strip, /\bsetInterval\b(?![\s\S]*clearInterval)/); // every timer has its clearing
  assert.doesNotMatch(strip, /height: \d/); // font-scale friendly: no fixed heights
});

test('the strip does its own fetching nowhere: no api call, no polling', () => {
  const strip = read('../src/components/FallbackStrip.tsx');
  assert.doesNotMatch(strip, /from '\.\.\/lib\/api'|\bapi</);
  const model = read('../src/components/ModelSheet.tsx');
  assert.equal((model.match(/api<AgentInfo>\(/g) ?? []).length, 1); // still the one fetch, reused
});

test('the amber colour comes from the theme warning tokens, for dark and light', () => {
  const strip = read('../src/components/FallbackStrip.tsx');
  assert.match(strip, /colors\.warning\b/);
  assert.match(strip, /colors\.warningSoft\b/);
  assert.doesNotMatch(strip, /#[0-9a-fA-F]{6}/); // no hard-coded colour
});

/**
 * The Pet screen broke because a const was read before its declaration. In every function body, flag a read of a
 * const/let that sits before the statement declaring it (reads inside nested functions run later, so they are fine).
 */
function usedBeforeDeclared(source: string): string[] {
  const file = ts.createSourceFile('f.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const checkBody = (body: ts.Block) => {
    const declared = new Map<string, number>();
    for (const statement of body.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) continue;
      for (const d of statement.declarationList.declarations) {
        const names = ts.isIdentifier(d.name) ? [d.name] : d.name.elements.flatMap((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) ? [e.name] : []);
        for (const name of names) declared.set(name.text, d.getEnd());
      }
    }
    const walk = (node: ts.Node) => {
      if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return; // runs later / not a runtime read
      if (ts.isIdentifier(node)) {
        const end = declared.get(node.text);
        const parent = node.parent;
        const declaring = ts.isVariableDeclaration(parent) && parent.name === node || ts.isBindingElement(parent) && parent.name === node;
        const member = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
        if (end !== undefined && !declaring && !member && node.getStart() < end) {
          problems.push(`${node.text} at line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      node.forEachChild(walk);
    };
    body.forEachChild(walk);
  };
  const visit = (node: ts.Node) => {
    const body = ts.isFunctionLike(node) ? (node as ts.FunctionLikeDeclaration).body : undefined;
    if (body && ts.isBlock(body)) checkBody(body);
    node.forEachChild(visit);
  };
  visit(file);
  return problems;
}

test('no const or let is read before its declaration in the files this change touches', () => {
  assert.deepEqual(usedBeforeDeclared('function f() {\n const a = b;\n const b = 1;\n return a;\n}'), ['b at line 2'], 'the guard itself catches the Pet bug');
  assert.deepEqual(usedBeforeDeclared('function f() { const b = 1; const a = b; return () => c + a; const c = 2; }'), []);
  for (const file of ['../src/lib/fallbackNotice.ts', '../src/lib/fallbackStore.ts', '../src/components/FallbackStrip.tsx',
    '../src/components/ModelSheet.tsx', '../src/components/Composer.tsx']) {
    assert.deepEqual(usedBeforeDeclared(read(file)), [], file);
  }
});
