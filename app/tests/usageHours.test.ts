import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function load(file: string) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date, Math, Map, Number, Array });
  return exports;
}

const lib = load('../src/lib/usageHours.ts');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const HOUR = 3600;
const MIDNIGHT = 1_767_225_600; // 2026-01-01 00:00 UTC
const payload = (hours: number[][]) => ({ from: MIDNIGHT - 7 * 86400, to: MIDNIGHT + 86400, hours });

test('the four token columns are summed; calls and cost are not tokens', () => {
  assert.equal(lib.hourTokens([MIDNIGHT, 100, 40, 7, 3, 999, 12345]), 150);
  assert.equal(lib.hourTokens([MIDNIGHT]), 0);
});

test('an empty or all-zero series is "no usage", a real one is not', () => {
  assert.equal(lib.hasUsage(null), false);
  assert.equal(lib.hasUsage(payload([])), false);
  assert.equal(lib.hasUsage(payload([[MIDNIGHT, 0, 0, 0, 0, 0, 0]])), false);
  assert.equal(lib.hasUsage(payload([[MIDNIGHT, 1, 0, 0, 0, 1, 0]])), true);
  assert.deepEqual(plain(lib.hourBars(payload([]))), []);
});

test('silent hours between recorded ones become zero bars', () => {
  const bars = lib.hourBars(payload([[MIDNIGHT + 3 * HOUR, 10, 0, 0, 0, 1, 5], [MIDNIGHT, 1, 1, 1, 1, 2, 7]]));
  assert.deepEqual(plain(bars.map((b: any) => [b.hour - MIDNIGHT, b.tokens, b.cents, b.calls])),
    [[0, 4, 7, 2], [HOUR, 0, 0, 0], [2 * HOUR, 0, 0, 0], [3 * HOUR, 10, 5, 1]]);
});

test('a phone never draws more bars than it was asked to', () => {
  const rows = Array.from({ length: 300 }, (_, i) => [MIDNIGHT + i * HOUR, 1, 0, 0, 0, 1, 0]);
  const bars = lib.hourBars(payload(rows), 168);
  assert.equal(bars.length, 168);
  assert.equal(bars[bars.length - 1].hour, MIDNIGHT + 299 * HOUR, 'the newest hours are the ones kept');
});

test('the day total sums every hour of that day only, across an hour boundary', () => {
  const bars = lib.hourBars(payload([
    [MIDNIGHT - HOUR, 100, 0, 0, 0, 1, 10],         // 23:00 the day before
    [MIDNIGHT, 1, 2, 3, 4, 1, 20],                   // 00:00
    [MIDNIGHT + 23 * HOUR, 10, 0, 0, 0, 2, 30],      // 23:00
    [MIDNIGHT + 24 * HOUR, 1000, 0, 0, 0, 1, 40],   // next day
  ]));
  assert.deepEqual(plain(lib.dayTotal(bars, MIDNIGHT + 5 * HOUR, 0)), { day: '2026-01-01', tokens: 20, cents: 50, calls: 3 });
  assert.deepEqual(plain(lib.dayTotal(bars, MIDNIGHT - HOUR, 0)), { day: '2025-12-31', tokens: 100, cents: 10, calls: 1 });
});

test('the day follows the phone zone, not UTC', () => {
  const bars = lib.hourBars(payload([[MIDNIGHT, 5, 0, 0, 0, 1, 0], [MIDNIGHT - 2 * HOUR, 7, 0, 0, 0, 1, 0]]));
  // At UTC+1 both 22:00 UTC (23:00) and 00:00 UTC (01:00 next day) split across the local midnight.
  assert.equal(lib.dayTotal(bars, MIDNIGHT, 60).tokens, 5);
  assert.equal(lib.dayTotal(bars, MIDNIGHT - 2 * HOUR, 60).tokens, 7);
  // At UTC-5 both fall on 31 December local time.
  assert.equal(lib.dayTotal(bars, MIDNIGHT, -300).tokens, 12);
});

test('bar heights scale to the busiest hour and keep a stub for a quiet one', () => {
  const bars = lib.hourBars(payload([[MIDNIGHT, 1000, 0, 0, 0, 1, 0], [MIDNIGHT + HOUR, 1, 0, 0, 0, 1, 0],
    [MIDNIGHT + 3 * HOUR, 500, 0, 0, 0, 1, 0]]));
  assert.deepEqual(plain(lib.barHeights(bars, 100)), [100, 2, 0, 50]);
  assert.deepEqual(plain(lib.barHeights([], 100)), []);
});

test('the Usage screen shows the empty state text and uses the endpoint with seven days', () => {
  const screen = readFileSync(new URL('../src/app/usage.tsx', import.meta.url), 'utf8');
  assert.match(screen, /No usage recorded yet/);
  assert.match(screen, /\/api\/usage\/hours\?days=7/);
  assert.match(screen, /hasUsage\(payload\)/);
});
