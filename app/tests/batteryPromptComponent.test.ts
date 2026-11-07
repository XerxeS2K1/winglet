import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { askAboutBatteryOnce, BATTERY_PROMPT_COPY } from '../src/lib/batteryPrompt.ts';

function load(file: string, modules: any, globals: any = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => { assert.ok(id in modules, `Unexpected import ${id}`); return modules[id]; }, ...globals });
  return exports;
}
const jsx = (type: any, props: any) => ({ type, props });
const themeModule = load('../src/lib/theme.ts', { 'react-native': { Platform: { select: (o: any) => o.default } } });
const flatten = (s: any): any => Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(flatten)) : s ?? {};
function harness(over: any = {}) {
  let state = { servers: [{}], foreground: true }, locked = false, path = '/', os = 'android', appState = 'active';
  let theme = themeModule.buildTheme('dark', 'iris'), cursor = 0, mounted = true, scheduled: any;
  let asked = false, requests = 0, outcomes: string[] = [], delayed: any, hold = false;
  const slots: any[] = [], effects: any[] = [], listeners = new Set<any>();
  const react = {
    useRef: (v: any) => { const i = cursor++; return slots[i] ??= { current: v }; },
    useState: (v: any) => { const i = cursor++; if (!(i in slots)) slots[i] = v; return [slots[i], (x: any) => { slots[i] = typeof x === 'function' ? x(slots[i]) : x; }]; },
    useEffect: (fn: any, deps: any[]) => { const i = cursor++; const old = effects[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) {
      old?.cleanup?.(); effects[i] = { deps, pending: fn };
    } },
    useMemo: (fn: any) => fn(),
  };
  const useApp: any = (f: any) => f(state); useApp.getState = () => state;
  const useLock: any = (f: any) => f({ locked }); useLock.getState = () => ({ locked });
  const native = { batteryUnrestricted: () => false, requestBatteryUnrestricted: () => { requests++; } };
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'expo-router': { usePathname: () => path },
    'react-native': { get Platform() { return { OS: os }; }, AppState: { get currentState() { return appState; },
      addEventListener: (_: any, fn: any) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } },
      Text: 'Text', View: 'View', Alert: { alert: () => { throw Error('App-owned native alert'); } } },
    '../lib/themeContext': { useTheme: () => theme }, './Sheet': { Sheet: 'Sheet', SheetAction: 'SheetAction' },
    '../features/encrypted-push/native': { pushNative: native }, '../lib/appLock': { useLock }, '../lib/store': { useApp },
    '../lib/storage': { getItem: async () => { if (hold) await new Promise((r) => { delayed = r; }); return asked ? '1' : null; }, setItem: async () => { asked = true; } },
    '../lib/batteryPrompt': { BATTERY_PROMPT_COPY, BATTERY_PROMPT_KEY: 'key', askAboutBatteryOnce: async (d: any) => { const result = await askAboutBatteryOnce(d); outcomes.push(result); return result; } },
  };
  const { BatteryPrompt } = load('../src/components/BatteryPrompt.tsx', modules, {
    setTimeout: (fn: any, ms: any) => { assert.equal(ms, 5000); scheduled = fn; return 1; }, clearTimeout: () => { scheduled = null; },
  });
  function render() { cursor = 0; const tree = BatteryPrompt(); for (const e of effects) if (e?.pending) { const fn = e.pending; e.pending = null; e.cleanup = fn(); } return tree; }
  return {
    render, theme: (t: any) => { theme = t; }, fire: async () => { scheduled?.(); await flush(); },
    change: (v: any) => { if ('locked' in v) locked = v.locked; if ('path' in v) path = v.path; if ('os' in v) os = v.os;
      state = { ...state, ...('foreground' in v ? { foreground: v.foreground } : {}), ...('paired' in v ? { servers: v.paired ? [{}] : [] } : {}) }; return render(); },
    background: () => { appState = 'background'; for (const fn of listeners) fn('background'); },
    unmount: () => { mounted = false; for (const e of effects) e?.cleanup?.(); },
    hold: () => { hold = true; }, release: () => { hold = false; delayed?.(); },
    inspect: () => ({ asked, requests, outcomes, mounted }),
  };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function children(tree: any): any[] { return [tree, ...([tree?.props?.children].flat(Infinity).filter(Boolean).flatMap(children))]; }
function action(tree: any, label: string) { const node = children(tree).find((n) => n?.props?.label === label); assert.ok(node, label); return node.props.onPress; }

test('battery explanation is deferred, themed, scrollable and has wrapping action rows for long copy', async () => {
  const h = harness(); const initial = h.render(); assert.ok(!initial || !initial.props.visible);
  await h.fire(); const tree = h.render(); assert.equal(tree.type, 'Sheet'); assert.equal(tree.props.visible, true);
  assert.equal(tree.props.scrollable, true); assert.equal(tree.props.title, BATTERY_PROMPT_COPY.title);
  assert.equal(children(tree).find((n) => n?.type === 'Text')?.props.children, BATTERY_PROMPT_COPY.message);
  assert.ok(!children(tree).some((n) => flatten(n?.props?.style).height || n?.props?.numberOfLines));
  action(tree, BATTERY_PROMPT_COPY.go)(); action(tree, BATTERY_PROMPT_COPY.go)(); tree.props.onClose();
  await flush(); assert.equal(h.inspect().requests, 1); assert.deepEqual(h.inspect().outcomes, ['requested']);
});

test('battery explanation tracks all six accents and every resolved light/dark tone without reading system colours', async () => {
  const h = harness(); h.render(); await h.fire();
  for (const scheme of ['light', 'dark']) for (const tone of ['charcoal', 'graphite', 'black']) for (const accent of themeModule.ACCENT_NAMES) {
    const t = themeModule.buildTheme(scheme, accent, tone); h.theme(t); const tree = h.render();
    assert.equal(tree.type, 'Sheet'); const body = children(tree).find((n) => n?.type === 'Text');
    assert.equal(flatten(body.props.style).color, t.colors.textSecondary);
  }
});

for (const reason of ['later', 'back', 'dismiss', 'lock', 'background', 'foreground', 'pair', 'scan', 'navigation', 'unpaired', 'unmount']) {
  test(`battery prompt settles once and rejects stale Continue after ${reason}`, async () => {
    const h = harness(); h.render(); await h.fire(); const tree = h.render(); const go = action(tree, BATTERY_PROMPT_COPY.go); console.error('GO type', typeof go); try { go(); console.error('GO called OK'); } catch(e) { console.error('GO threw', e); } console.error('GO src', go.toString());
    if (reason === 'later') action(tree, BATTERY_PROMPT_COPY.later)();
    else if (reason === 'back') tree.props.onClose();
    else if (reason === 'dismiss') tree.props.onDismiss();
    else if (reason === 'lock') h.change({ locked: true });
    else if (reason === 'background') h.background();
    else if (reason === 'foreground') h.change({ foreground: false });
    else if (reason === 'pair' || reason === 'scan') h.change({ path: '/' + reason });
    else if (reason === 'navigation') h.change({ path: '/settings' });
    else if (reason === 'unpaired') h.change({ paired: false });
    else h.unmount();
    go(); go(); await flush(); console.error('DBG requests', h.inspect().requests, 'outcomes', h.inspect().outcomes, 'path', (global as any).__dbg); assert.equal(h.inspect().requests, 0); assert.deepEqual(h.inspect().outcomes, ['declined']);
  });
}
for (const change of [{ os: 'web' }, { os: 'ios' }, { locked: true }, { paired: false }, { foreground: false }, { path: '/pair' }, { path: '/scan' }]) {
  test(`battery prompt stays absent when ineligible ${JSON.stringify(change)}`, async () => {
    const h = harness(); h.change(change); await h.fire(); assert.equal(h.inspect().asked, false); assert.equal(h.inspect().requests, 0);
  });
}
test('losing eligibility during storage does not reveal a late sheet or request Android', async () => {
  const h = harness(); h.hold(); h.render(); await h.fire(); h.change({ locked: true }); h.release(); await flush();
  assert.equal(h.inspect().requests, 0); assert.ok(!h.render()?.props.visible);
});
test('Continue followed immediately by background cannot launch the OS request from its promise continuation', async () => {
  const h = harness(); h.render(); await h.fire(); action(h.render(), BATTERY_PROMPT_COPY.go)(); h.background(); await flush();
  assert.equal(h.inspect().requests, 0);
});
