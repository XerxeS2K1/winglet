import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('Devices defensive no-server return uses themed Footnote without adding conditional hooks', () => {
  let state: any = { servers: [], selection: {} }, hookCalls = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const anything: any = new Proxy(function () {}, { get: () => anything, apply: () => anything });
  const modules: any = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text' },
    '../components/ui': { Footnote: 'Footnote' },
    '../components/Screen': { Screen: 'Screen' },
    '../components/ServerScreen': { withSelectedServer: (component: any) => component },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => { hookCalls++; return {}; } },
    '../lib/store': { useApp: (select: any) => { hookCalls++; return select(state); } },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/app/devices.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id: string) => modules[id] ?? anything });
  const empty = exports.default(), emptyHookCount = hookCalls;
  assert.equal(empty.props.children.type, 'Footnote');
  assert.equal(empty.props.children.props.children, 'No bots paired yet.');
  hookCalls = 0; state = { servers: [{ id: 's' }], selection: { serverId: 's' } };
  const paired = exports.default(); assert.equal(paired.props.server.id, 's');
  assert.equal(hookCalls, emptyHookCount, 'hook order remains the same across early return');
});
