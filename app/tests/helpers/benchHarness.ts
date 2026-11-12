import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { shallow } from 'zustand/vanilla/shallow';

/**
 * Loads a production module from `src/` for the render-counting tests. `WINGLET_BENCH_SRC` points the same test at another
 * copy of `src/` (for example an older commit) so "before" and "after" numbers come from the very same test.
 */
const ROOT = process.env.WINGLET_BENCH_SRC ?? fileURLToPath(new URL('../../src/', import.meta.url));

export function loadSrc(file: string, modules: Record<string, any>, extra: Record<string, any> = {}) {
  const exports: any = {};
  const out = ts.transpileModule(readFileSync(join(ROOT, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(out, {
    exports, console,
    require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected import ${id} in ${file}`); return modules[id]; },
    ...extra,
  });
  return exports;
}

export const jsx = (type: any, props: any) => ({ type, props });

type Sub = { selector: (state: any) => any; last: any; shallow: boolean };

/**
 * A tiny stand-in for React's render loop, enough to count renders. Hooks keep their slots between renders; `useApp(selector)`
 * subscribes the way zustand does with useSyncExternalStore: the component renders again only when a selector it used returns
 * a different value (Object.is, or a shallow comparison for `useShallow`).
 */
export function renderer(store: { getState: () => any; subscribe: (fn: () => void) => () => void }) {
  let subs: Sub[] = [];
  /** The mount being drawn right now: the shared `react` stub below hands its hooks to it. */
  let current: { cursor: number; slots: any[]; onSet: () => void } | undefined;
  const react = {
    useState: (v: any) => {
      const c = current!, i = c.cursor++;
      if (!(i in c.slots)) c.slots[i] = typeof v === 'function' ? v() : v;
      return [c.slots[i], (next: any) => { const n = typeof next === 'function' ? next(c.slots[i]) : next; if (n !== c.slots[i]) { c.slots[i] = n; c.onSet(); } }];
    },
    useRef: (v: any) => { const c = current!, i = c.cursor++; return c.slots[i] ??= { current: v }; },
    useMemo: (f: () => any) => { current!.cursor++; return f(); },
    useCallback: (f: any) => { current!.cursor++; return f; },
    useEffect: () => { current!.cursor++; },
    memo: (f: any) => f,
  };
  const useApp: any = (selector: any) => {
    const value = selector(store.getState());
    subs.push({ selector, last: value, shallow: !!selector.shallow });
    return value;
  };
  useApp.getState = store.getState;
  useApp.subscribe = store.subscribe;
  const useShallow = (selector: any) => Object.assign((state: any) => selector(state), { shallow: true });

  /** Mount a component: `draw()` renders it once and returns its tree. Counts renders; redraws on a selector change or a setState. */
  function mount(draw: () => any) {
    const mine: Sub[] = [];
    const host = { cursor: 0, slots: [] as any[], onSet: () => run() };
    let renders = 0;
    let tree: any;
    const run = () => {
      const [outerCurrent, outerSubs] = [current, subs];
      host.cursor = 0; current = host;
      subs = mine; subs.length = 0;
      renders += 1;
      try { tree = draw(); } finally { current = outerCurrent; subs = outerSubs; }
    };
    run();
    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      const changed = mine.some((s) => { const next = s.selector(state); return s.shallow ? !shallow(s.last, next) : !Object.is(s.last, next); });
      if (changed) run();
    });
    return { get tree() { return tree; }, get renders() { return renders; }, unmount: unsubscribe };
  }
  return { mount, react, useApp, useShallow };
}

export function nodes(n: any): any[] {
  return n && typeof n === 'object' ? [n, ...[n.props?.children, n.props?.right].flat(Infinity).flatMap(nodes)] : [];
}
