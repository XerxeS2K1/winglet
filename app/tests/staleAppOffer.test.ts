import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const compareVersions = (a: string, b: string) => {
  const p = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
};

function load(file: string, modules: Record<string, any>) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, console, require: (name: string) => modules[name] });
  return exports;
}

/** Renders the real UpdatePrompt with one running version and one offered release. */
async function prompt(running: string, offered: string) {
  let cursor = 0, mounted = false;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: Record<string, any> = {
    'expo-constants': { expoConfig: { version: running } },
    react: {
      useState: (initial: any) => {
        const index = cursor++;
        if (!mounted) states[index] = initial;
        return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useEffect: (fn: () => void) => { if (!mounted) fn(); },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View' },
    '../lib/unifiedUpdateFlow': { useUnifiedUpdate: (fn: any) => fn({ loaded: true, record: null }), unifiedUpdate: { record: null, recoverOrphan: async () => {} }, updateContext: () => ({ server: undefined }) },
    '../lib/appInstall': { useAppInstall: (select: any) => select({ phase: 'idle' }) },
    '../lib/updateJobs': { updateScope: () => undefined },
    '../lib/version': { compareVersions },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: (select: any) => select({ update: { version: offered } }) },
    '../lib/appLock': { useLock: (select: any) => select({ locked: false }) },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { updateCheck: true } }) },
    '../lib/storage': { getJSON: async () => null },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({}) },
    '../lib/serverUpdates': { serverUpdateKey: () => 's', checkServerUpdates: async () => {}, updateServerWinglet: async () => {}, useServerUpdates: () => () => ({}) },
    './icons': {}, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button' },
  };
  const exports = load('../src/components/AppUpdate.tsx', modules);
  const render = () => { cursor = 0; const tree = exports.UpdatePrompt(); mounted = true; return tree; };
  render();
  await new Promise((resolve) => setImmediate(resolve));
  return render();
}

test('a release this build already runs is never offered again', async () => {
  // The regression: after Android installs the update the process can still be the old build, and the
  // sheet came back saying "0.10.10 is out. You have 0.10.9" on a phone that already had 0.10.10.
  assert.equal(await prompt('0.10.10', '0.10.10'), null);
  assert.equal(await prompt('0.10.11', '0.10.10'), null, 'an older release is not an update either');
  const newer = await prompt('0.10.9', '0.10.10');
  assert.ok(newer, 'a genuinely newer release still offers itself');
  assert.equal(newer.props.visible, true);
});

test('forget() drops the offer and its cache so a handed-over install stops asking', async () => {
  let stored: any = 'unset';
  const state: any = { update: { version: '0.10.10' }, checkedAt: 5, failed: false };
  const storage = { getJSON: async () => null, setJSON: async (_key: string, value: any) => { stored = value; } };
  const { useAppUpdate } = load('../src/lib/appUpdateCheck.ts', {
    'expo-constants': { expoConfig: { version: '0.10.9' } },
    'expo-device': { supportedCpuArchitectures: [] },
    'react-native': { Platform: { OS: 'android' } },
    zustand: {
      create: (init: any) => {
        const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
        const get = () => state;
        const api: any = (select: any) => select(state);
        api.getState = get;
        Object.assign(state, init(set, get));
        return api;
      },
    },
    './appUpdate': { checkIsFresh: () => false, newestUpdate: () => null, RELEASES_URL: 'x' },
    './storage': storage,
  });
  useAppUpdate.getState().forget();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.update, null);
  assert.equal(state.checkedAt, undefined);
  assert.equal(stored, null, 'the cached offer is cleared too, so a relaunch does not bring it back');
});
