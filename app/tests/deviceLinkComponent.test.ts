import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
function pairScreen() {
  let index = 0, requests = 0; const slots: any[] = [];
  const react = { useState: (v: any) => { const i = index++; if (!(i in slots)) slots[i] = typeof v === 'function' ? v() : v; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef: (v: any) => { const i = index++; return slots[i] ??= { current: v }; }, useEffect: () => {}, useCallback: (f: any) => f };
  const jsx = (type: any, props: any) => ({ type, props });
  const empty: any = new Proxy(() => {}, { get: () => empty });
  const state = { servers: [] }, useApp: any = (fn: any) => fn(state); useApp.getState = () => state;
  const modules: any = {
    'react': react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'expo-router': { router: empty, useLocalSearchParams: () => ({}) },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'web' }, StyleSheet: {} },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, FadeIn: empty }, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '../components/BrowserSignIn': { BrowserSignIn: 'BrowserSignIn' }, '../components/BotAvatar': { BotAvatar: 'BotAvatar' }, '../components/icons': empty, '../components/Logo': { Logo: 'Logo' },
    '../components/ui': { Button: 'Button', Field: 'Field', Footnote: 'Footnote', IconButton: 'IconButton' },
    '../lib/api': { defaultDeviceName: () => 'Browser', normalizeUrl: (x: string) => x }, '../lib/pairing': { connectPairing: async () => { requests++; return {}; } },
    '../lib/motion': { useReducedMotion: () => true }, '../lib/push': { isIOS: () => false, isStandalone: () => false }, '../lib/store': { useApp }, '../lib/themeContext': { makeStyles: () => () => empty, useTheme: () => empty },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/app/pair.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (n: string) => { assert.ok(n in modules, n); return modules[n]; }, location: { origin: 'https://box.example' } });
  const render = () => { index = 0; return exports.default(); };
  return { render, requests: () => requests };
}
function nodes(value: any): any[] { if (!value || typeof value !== 'object') return []; if (Array.isArray(value)) return value.flatMap(nodes); return [value, ...nodes(value.props?.children)]; }
test('a browser storage failure cannot fall through to manual pairing and create a second identity', async () => {
  const h = pairScreen(); const panel = nodes(h.render()).find((n) => n.type === 'BrowserSignIn');
  assert.equal(typeof panel.props.onPhase, 'function'); panel.props.onPhase('save-error');
  const action = nodes(h.render()).find((n) => n.props?.title === 'Connect');
  assert.equal(action.props.disabled, true); await action.props.onPress(); assert.equal(h.requests(), 0);
});
