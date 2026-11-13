import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// A tiny stand-in for React's hooks, enough to run one screen's effects and count what they start. It is not a renderer:
// it runs a component function directly, then runs the effects whose dependencies changed (cleanup first), as React does.
export const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });
const same = (a?: any[], b?: any[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export function hookRuntime() {
  let cursor = 0, renders = 0, stateWrites = 0;
  const hooks: any[] = [], effects: (() => void)[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const effect = (callback: () => any, deps?: any[]) => {
    const i = cursor++, old = hooks[i];
    if (!old || !deps || !same(old.deps, deps)) {
      hooks[i] = { deps, cleanup: old?.cleanup };
      effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); });
    }
  };
  const react = {
    useState: (initial: any) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], (v: any) => { stateWrites++; hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
    },
    useRef: (initial: any) => { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useCallback: (fn: any, deps: any[]) => { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { fn, deps }; return hooks[i].fn; },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const clock = { now: Date.now() };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const globals = {
    setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearInterval: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  /** Compile a source file from src/ and return its exports; `modules` answers its imports, anything else is inert. */
  const load = (path: string, modules: Record<string, any>, append = '') => {
    const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8') + append;
    const jsx = (type: any, props: any) => ({ type, props });
    const all: Record<string, any> = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, ...modules };
    const exports: any = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { exports, require: (id: string) => all[id] ?? fallback, ...globals, Date: FakeDate, AbortController });
    return exports;
  };
  const render = <T>(component: () => T): T => {
    cursor = 0; renders++;
    const tree = component();
    while (effects.length) effects.shift()!();
    return tree;
  };
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  return { react, load, render, unmount, timers, clock, effect, stats: () => ({ renders, stateWrites }), live: () => timers.filter((t) => !t.cleared) };
}
export const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
