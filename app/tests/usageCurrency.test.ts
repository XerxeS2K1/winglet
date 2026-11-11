import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const any: any = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : any),
  apply: () => any,
});
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const load = (file: string, modules: Record<string, any> = {}) => {
  const exports: any = {};
  vm.runInNewContext(compile(file), { exports, require: (m: string) => modules[m] ?? any });
  return exports;
};
const currency = load('lib/currency.ts');
const { formatCost, shownCurrency, DEFAULT_CURRENCY } = currency;

test('pounds are the default currency, on the helper and in the saved preferences', () => {
  assert.equal(DEFAULT_CURRENCY, 'gbp');
  const prefs = load('lib/prefs.ts', { zustand: { create: (init: any) => init(() => {}, () => ({})) }, './currency': currency });
  assert.equal(prefs.DEFAULT_PREFS.currency, 'gbp');
});

test('a saved preference without a currency still loads as pounds, and a saved dollar choice is kept', async () => {
  let saved: any = { theme: 'dark' };
  let state: any;
  const create = (init: any) => { state = init((patch: any) => { state = { ...state, ...patch }; }, () => state); return state; };
  const prefs = load('lib/prefs.ts', { zustand: { create }, './currency': currency, './storage': { getJSON: async () => saved, setJSON: (_k: string, v: any) => { saved = v; } } });
  await prefs.usePrefs.load();
  assert.equal(state.prefs.currency, 'gbp');
  assert.equal(state.prefs.theme, 'dark');
  saved = { currency: 'usd' };
  await prefs.usePrefs.load();
  assert.equal(state.prefs.currency, 'usd');
});

test('pounds: converts with the rate and rounds to pence', () => {
  assert.equal(formatCost(10, 'gbp', 0.745), '£7.45');
  assert.equal(formatCost(1, 'gbp', 0.74547), '£0.75');
  assert.equal(formatCost(123.456, 'gbp', 0.8), '£98.76');
  assert.equal(formatCost(2, 'gbp', 0.8), '£1.60');
});

test('small amounts: under a penny after converting reads <£0.01, and a penny exactly shows', () => {
  assert.equal(formatCost(0.003, 'gbp', 0.745), '<£0.01');
  assert.equal(formatCost(0.0099, 'gbp', 1), '<£0.01');
  assert.equal(formatCost(0.01, 'gbp', 1), '£0.01');
  // 1.3 cents of dollars is 0.97p: under a penny in pounds, though not in dollars.
  assert.equal(formatCost(0.013, 'gbp', 0.745), '<£0.01');
  assert.equal(formatCost(0.013, 'usd', 0.745), '$0.01');
  assert.equal(formatCost(0.003, 'usd'), '<$0.01');
});

test('zero and nonsense amounts read as nothing, with the right symbol', () => {
  for (const bad of [0, -3, NaN, Infinity, undefined, null]) {
    assert.equal(formatCost(bad as any, 'gbp', 0.745), '£0');
    assert.equal(formatCost(bad as any, 'usd', 0.745), '$0');
    assert.equal(formatCost(bad as any, 'gbp'), '$0'); // no rate: dollars
  }
});

test('with no usable rate, pounds fall back to dollars and never get a £', () => {
  for (const rate of [undefined, null, 0, -1, NaN, Infinity, '0.75', {}]) {
    assert.equal(formatCost(10, 'gbp', rate), '$10.00', String(rate));
    assert.equal(shownCurrency('gbp', rate), 'usd');
    assert.doesNotMatch(formatCost(0.003, 'gbp', rate), /£/);
    assert.doesNotMatch(formatCost(0, 'gbp', rate), /£/);
  }
});

test('dollars stay dollars whatever the rate, unconverted', () => {
  assert.equal(formatCost(10, 'usd', 0.745), '$10.00');
  assert.equal(formatCost(10, 'usd'), '$10.00');
  assert.equal(shownCurrency('usd', 0.745), 'usd');
  assert.equal(shownCurrency('gbp', 0.745), 'gbp');
});

test('the Usage screen has a £ / $ control that saves to the device and passes one formatter to every cost', () => {
  const screen = readFileSync(new URL('../src/app/usage.tsx', import.meta.url), 'utf8');
  assert.match(screen, /<Segmented label="Currency"/);
  assert.match(screen, /label: '£'/);
  assert.match(screen, /label: '\$'/);
  assert.match(screen, /usePrefs\(\(st\) => st\.prefs\.currency\)/);
  assert.match(screen, /setCurrency\(\{ currency: c \}\)/);
  assert.match(screen, /formatCost\(usd, currency, data\?\.usd_gbp\)/);
  for (const part of ['HourlyBars payload={hours}', 'DailyBars rows={data.daily}', 'Models rows={data.by_model}']) {
    assert.ok(screen.includes(`${part} money={money}`), part);
  }
  assert.doesNotMatch(screen, /'<\$0\.01'|`\$\$\{/); // no hard-coded dollar formatting left
  assert.match(screen, /usd_gbp\?: number/);
});

test('the chart readout shows the formatter it is given, and dollars when it is given none', () => {
  let cursor = 0;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const modules = {
    react: { useState: (i: any) => { const k = cursor++; states[k] ??= i; return [states[k], () => {}]; }, useEffect: () => {} },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View' },
    '../lib/currency': currency,
  };
  const bars = load('app/usage.tsx', modules);
  const text = (n: any): string => (n == null || typeof n !== 'object' ? String(n ?? '') : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children));
  const rows = [{ day: '2026-10-14', input_tokens: 1000, output_tokens: 0, estimated_cost: 10 }];
  cursor = 0;
  assert.match(text(bars.DailyBars({ rows }).props.children[0]), /\$10\.00/);
  cursor = 0;
  assert.match(text(bars.DailyBars({ rows, money: (usd: number) => formatCost(usd, 'gbp', 0.5) }).props.children[0]), /£5\.00/);
});
