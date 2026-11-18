import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Event-order logging for the fast type-then-Send investigation (src/lib/perf.ts, Composer.tsx, store.ts).

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function load(env: { flag?: string; dev?: boolean } = {}) {
  const exports: any = {};
  const logs: string[] = [];
  const state = { now: 1000, throwLog: false, intervals: [] as (() => void)[], cleared: 0 };
  const sandbox: any = {
    exports,
    process: { env: env.flag === undefined ? {} : { EXPO_PUBLIC_WINGLET_PERF: env.flag } },
    performance: { now: () => state.now },
    console: { log: (...a: unknown[]) => { if (state.throwLog) throw new Error('private exception fixture'); logs.push(a.join(' ')); } },
    setInterval: (cb: () => void) => state.intervals.push(cb),
    clearInterval: () => { state.cleared += 1; },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  if (env.dev !== undefined) sandbox.__DEV__ = env.dev;
  vm.runInNewContext(ts.transpileModule(read('../src/lib/perf.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  return { perf: exports, logs, state };
}

const body = (l: string) => l.replace('[winglet-perf] ', '');

test('pure helpers: a line carries a sequence number, a time, and only numbers, booleans or short words', () => {
  const { perf } = load();
  assert.equal(perf.eventLine(3, 1234.56, 'send-entry', { rendered: 5, ready: true, busyMode: 'queue' }), '#3 +1234.6ms send-entry rendered=5 ready=true busyMode=queue');
  // Anything that could be message text is replaced, never printed.
  assert.equal(perf.safeValue('Hello there, my password is x'), '?');
  assert.equal(perf.safeValue('hi\nthere'), '?');
  assert.equal(perf.safeValue(NaN), '?');
  assert.equal(perf.safeValue({ text: 'x' }), '?');
  assert.equal(perf.safeValue('secret'), '?', 'only fixed enum strings may be printed');
});

test('sends get small numbers, not their client ids; an unknown id has no number; old ones are forgotten', () => {
  const { perf } = load();
  const labels = new perf.SendLabels();
  assert.equal(labels.label('c-abc'), 1);
  assert.equal(labels.label('c-def'), 2);
  assert.equal(labels.label('c-abc'), 1);
  assert.equal(labels.peek('c-zzz'), undefined);
  for (let i = 0; i < perf.SEND_LABELS_MAX + 5; i += 1) labels.label(`x${i}`);
  assert.equal(labels.peek('c-abc'), undefined, 'bounded: the oldest is dropped');
});

test('the stall detector reports only a gap above 100 ms', () => {
  const { perf } = load();
  const d = new perf.StallDetector();
  assert.equal(d.tick(0), null, 'the first tick has nothing to compare with');
  assert.equal(d.tick(50), null);
  assert.equal(d.tick(150), null, 'exactly 100 ms is not above the limit');
  assert.equal(d.tick(251), 101);
  assert.equal(d.tick(300), null);
});

test('with the switch on the events come out in order with a sequence number and no text', () => {
  const { perf, logs } = load({ dev: false, flag: '1' });
  perf.perfInput(1);
  perf.perfInput(2);
  perf.perfSendEntry({ rendered: 2, draft: 4, ready: true, busy: true, busyMode: 'queue', withValue: false, inFlight: false });
  perf.perfSendPassed(2, 0);
  perf.perfSendStage('c-private-id', 'outbox', { retry: false, online: true });
  perf.perfSendStage('c-private-id', 'post-start');
  perf.perfSendStage('c-private-id', 'http-return');
  perf.perfSendEcho('c-private-id');
  perf.perfSendEcho('c-from-another-phone');
  assert.deepEqual(logs.map(body), [
    '#1 +1000ms input len=1',
    '#2 +1000ms input len=2',
    '#3 +1000ms send-entry rendered=2 draft=4 ready=true busy=true busyMode=queue withValue=false inFlight=false',
    '#4 +1000ms send-passed passed=2 draftAfter=0',
    '#5 +1000ms outbox send=1 retry=false online=true',
    '#6 +1000ms post-start send=1',
    '#7 +1000ms http-return send=1',
    '#8 +1000ms socket-echo send=1',
  ]);
  assert.ok(logs.every((l) => l.startsWith('[winglet-perf] ')));
  assert.doesNotMatch(logs.join('\n'), /private|another/);
});

test('the stall watch starts once, only with the switch on, and logs only a gap over 100 ms', () => {
  const { perf, logs, state } = load({ dev: false, flag: '1' });
  perf.perfInput(1);
  perf.perfInput(2);
  assert.equal(state.intervals.length, 1, 'one interval, not one per event');
  state.now += 50; state.intervals[0]();
  state.now += 60; state.intervals[0]();
  assert.equal(logs.filter((l) => /js-stall/.test(l)).length, 0, 'ordinary ticks are silent');
  state.now += 340; state.intervals[0]();
  const stalls = logs.filter((l) => /js-stall/.test(l)).map(body);
  assert.deepEqual(stalls, ['#3 +1450ms js-stall gapMs=340 tickMs=50']);
  state.throwLog = true;
  assert.doesNotThrow(() => perf.perfInput(3));
  state.now += 200;
  assert.doesNotThrow(() => state.intervals[0]());
  perf.perfStopStallWatch();
  assert.equal(state.cleared, 1);
});

test('with the switch off nothing is logged and no interval is started', () => {
  const { perf, logs, state } = load({ dev: false });
  assert.equal(perf.PERF_ON, false);
  perf.perfInput(1);
  perf.perfSendEntry({ rendered: 1, draft: 1, ready: true, busy: false, busyMode: 'interrupt', withValue: false, inFlight: false });
  perf.perfSendPassed(1, 0);
  perf.perfSendStage('c', 'outbox');
  perf.perfSendEcho('c');
  assert.deepEqual(logs, []);
  assert.equal(state.intervals.length, 0);
});

// The guard rule: building the observation is itself work, so every call site checks PERF_ON first, on the same line.
const CALLS = /\b(perfInput|perfSendEntry|perfSendPassed|perfSendSettled|perfSendStage|perfSendEcho)\(/g;

function unguarded(rel: string): string[] {
  const bad: string[] = [];
  read(rel).split('\n').forEach((line, i) => {
    if (/^\s*(import|export)\b/.test(line) || /^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(CALLS)) {
      const before = line.slice(0, m.index);
      if (!/(if \(PERF_ON\b|\bPERF_ON &&)/.test(before)) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
  return bad;
}

test('every send-order call in Composer and the store is behind PERF_ON on the same line', () => {
  const sites = (rel: string) => [...read(rel).matchAll(CALLS)].length;
  assert.equal(sites('../src/components/Composer.tsx'), 4, 'Composer: input, send entry, send passed, send settled');
  assert.equal(sites('../src/lib/store.ts'), 6, 'store: deferred, post-start, http-return, http-error, outbox, socket echo');
  assert.deepEqual(unguarded('../src/components/Composer.tsx'), []);
  assert.deepEqual(unguarded('../src/lib/store.ts'), []);
});

test('the guard check itself fails when a guard is removed', () => {
  const sample = ["      if (PERF_ON) perfSendStage(id, 'post-start');", "      perfSendStage(id, 'http-return');"];
  const check = (line: string) => { const m = [...line.matchAll(CALLS)][0]; return /(if \(PERF_ON\b|\bPERF_ON &&)/.test(line.slice(0, m.index)); };
  assert.equal(check(sample[0]), true);
  assert.equal(check(sample[1]), false);
});

test('the Composer keeps its behaviour: onChangeText still stores the text, and Send still passes the rendered text', () => {
  const c = read('../src/components/Composer.tsx');
  assert.match(c, /onChangeText=\{\(v\) => \{ if \(PERF_ON\) perfInput\(v\.length\); setText\(v\); \}\}/);
  assert.match(c, /const submission = sendDraft\(server\.id, destination, body, prefix\);\n\s+if \(PERF_ON\) perfSendPassed\(/, 'observe immediately after invocation, before awaiting admission');
  assert.match(c, /const accepted = await submission;\n\s+if \(PERF_ON\) perfSendSettled\(accepted,/);
  assert.match(c, /if \(!accepted\) return;/, 'preserve admission-dependent sounds and clearing');
  assert.match(c, /const body = prepareChat \? useApp\.getState\(\)\.drafts\[draftKey\(server\.id, destination\)\] \?\? text : text;/);
});

// The privacy check reads only the input/send section of perf.ts. If that section cannot be found the check must
// fail, not pass on an empty or one-character slice.
const SECTION_MARKER = '// -- input and send event order';
const LEAKS = /\.text\b|\bbody\b|token|fetch\(|XMLHttpRequest|WebSocket|url/i;

function privacySection(source: string): string {
  const start = source.indexOf(SECTION_MARKER);
  assert.notEqual(start, -1, `section marker not found in perf.ts: ${SECTION_MARKER}`);
  const section = source.slice(start);
  // A renamed marker that still matched something else would leave the check guarding the wrong code.
  assert.match(section, /export function perfInput\(/, 'the section must contain the input hook');
  assert.match(section, /export function perfSendEcho\(/, 'the section must contain the echo hook');
  return section;
}

test('the logging never reads message text', () => {
  const section = privacySection(read('../src/lib/perf.ts'));
  assert.ok(section.length > 500, 'the guarded section is not trivially short');
  assert.doesNotMatch(section, LEAKS);
});

test('the privacy check fails when its section marker is missing, and still catches a leak when it is present', () => {
  const perf = read('../src/lib/perf.ts');
  // The marker renamed or absent (as in v0.12.3 before this change): the check must throw, not pass vacuously.
  assert.throws(() => privacySection(perf.replace(SECTION_MARKER, '// -- renamed')), /section marker not found/);
  assert.throws(() => privacySection(''), /section marker not found/);
  // Marker present but the hooks gone: also a failure.
  assert.throws(() => privacySection(`${SECTION_MARKER}\nexport const x = 1;\n`), /input hook/);
  // With the marker present, a text read inside the section is seen.
  const leaky = privacySection(`${perf}\nexport function leak(m: { text: string }) { return m.text; }\n`);
  assert.match(leaky, LEAKS);
});

test('the watch expires after an idle minute and restarts on activity', () => {
  const { perf, logs, state } = load({ flag: '1' });
  perf.perfInput(1);
  state.now += perf.STALL_IDLE_MS;
  state.intervals[0]();
  assert.equal(state.cleared, 1);
  assert.equal(logs.filter((l) => l.includes('js-stall')).length, 0);
  perf.perfInput(2);
  assert.equal(state.intervals.length, 2);
  perf.perfSendSettled(false, 2);
  assert.match(logs.at(-1)!, /send-settled accepted=false draftAfter=2/);
});
