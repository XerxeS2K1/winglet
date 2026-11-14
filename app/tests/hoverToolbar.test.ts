import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// On the web, hovering a message shows a Copy / Reply / More toolbar. react-native-web's Pressable "contains" hover:
// when the pointer enters a Pressable nested inside another one that has onHoverIn/onHoverOut (each toolbar button is
// one), the outer hover ends, so the toolbar unmounted the instant the pointer reached it. These tests pin the structure
// that avoids that. (Found and confirmed in a real browser; see the commit message.)

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : fallback, apply: () => fallback });
const SOURCE = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');

function harness(mouse: boolean) {
  let cursor = 0;
  const states: any[] = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const native: any = { Platform: { OS: 'web' }, View: 'View', Pressable: 'Pressable', Text: 'Text' };
  const modules: Record<string, any> = {
    react: { memo: (fn: any) => fn, useState: (value: any) => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], (v: any) => { states[i] = v; }]; },
      useEffect: () => undefined, useCallback: (fn: any) => fn, useMemo: (fn: any) => fn(), useRef: () => ({ current: null }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': new Proxy(native, { get: (t, key) => key in t ? t[key] : fallback }),
    '../lib/statusNotice': { statusNoticeText: () => '' },
    '../lib/messages': { sentByScript: () => false, isActivity: () => false },
    '../lib/store': { useApp: () => false, isOwner: () => false },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
  };
  const exports: any = {};
  const out = ts.transpileModule(SOURCE + '\nexport { HoverArea, HoverBar, MessageRow, RaisedCell };',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  // A mouse browser has (hover: hover); a phone or tablet reports (hover: none) and gets the touch layout.
  vm.runInNewContext(out, { exports, matchMedia: () => ({ matches: !mouse }), require: (id: string) => modules[id] ?? fallback });
  const message = { id: 'm1', chat_id: 'c', role: 'user', text: 'older message', status: 'final', created_at: 1, meta: {} };
  const render = () => {
    cursor = 0;
    return exports.MessageRow({ server: { id: 's', bot: { title: 'Bot' } }, message, first: false, last: false, fresh: false, layout: 'bubbles', flash: false, actions: {} });
  };
  return { exports, render };
}

type Node = { type: any; props: any };
/** Every element in the tree with the chain of elements above it; HoverArea is a real component here, so it is expanded. */
function walk(exports: any, node: any, parents: Node[] = [], out: { node: Node; parents: Node[] }[] = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(exports, n, parents, out)); return out; }
  if (!('type' in node)) return out;
  if (exports.HoverArea && node.type === exports.HoverArea) return walk(exports, node.type(node.props), parents, out);
  out.push({ node, parents });
  walk(exports, node.props?.children, [...parents, node], out);
  return out;
}
const find = (list: ReturnType<typeof walk>, pred: (n: Node) => boolean) => list.filter((e) => pred(e.node));

test('hover is tracked outside any Pressable, so the toolbar buttons cannot end it', () => {
  const h = harness(true);
  const before = walk(h.exports, h.render());
  assert.equal(find(before, (n) => n.props?.onHoverIn || n.props?.onHoverOut).length, 0, 'no element may use onHoverIn/onHoverOut');
  const areas = find(before, (n) => n.type === 'View' && n.props.onPointerEnter && n.props.onPointerLeave);
  assert.equal(areas.length, 1);
  assert.equal(find(before, (n) => n.type === h.exports.HoverBar).length, 0, 'no toolbar until the pointer arrives');

  areas[0].node.props.onPointerEnter();
  const during = walk(h.exports, h.render());
  const bar = find(during, (n) => n.type === h.exports.HoverBar);
  assert.equal(bar.length, 1, 'toolbar shows while the pointer is over the message');
  assert.ok(bar[0].parents.some((p) => p.props.onPointerEnter), 'the toolbar is inside the hover area, so pointing at it keeps it open');
  assert.equal(bar[0].parents.filter((p) => p.type === 'Pressable' && (p.props.onHoverIn || p.props.onHoverOut)).length, 0);

  find(during, (n) => !!n.props?.onPointerLeave)[0].node.props.onPointerLeave();
  assert.equal(find(walk(h.exports, h.render()), (n) => n.type === h.exports.HoverBar).length, 0, 'toolbar goes when the pointer leaves');
});

test('touch layouts get no hover wrapper and no hover toolbar', () => {
  const h = harness(false);
  const tree = walk(h.exports, h.render());
  assert.equal(find(tree, (n) => n.props?.onPointerEnter || n.props?.onHoverIn).length, 0);
  assert.equal(find(tree, (n) => n.type === h.exports.HoverBar).length, 0);
  assert.equal(typeof find(tree, (n) => n.type === 'Pressable')[0].node.props.onLongPress, 'function', 'long-press still opens the message menu');
});

test('a newer row is stacked above the older row over it, so the toolbar overhang gets the pointer', () => {
  const h = harness(true);
  const z = (index: number) => h.exports.RaisedCell({ index, style: { transform: [{ scaleY: -1 }] }, children: 'row' }).props.style.at(-1).zIndex;
  assert.ok(z(0) > z(1) && z(1) > z(2) && z(2) > z(500), 'index 0 is the newest row and must be on top');
  assert.deepEqual(h.exports.RaisedCell({ index: 1, style: { a: 1 }, children: 'x' }).props.style[0], { a: 1 }, 'keeps the list\'s own cell style');
  const cell = h.exports.RaisedCell({ index: 1, style: {}, children: 'x', onLayout: () => 'layout' });
  assert.equal(cell.props.onLayout(), 'layout', 'the list still gets its layout events');
  // Phones and the native app keep the plain cells.
  assert.match(SOURCE, /CellRendererComponent=\{TOUCH \? undefined : RaisedCell\}/);
});
