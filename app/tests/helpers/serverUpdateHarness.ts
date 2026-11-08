import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
export function load(file: string, modules: any, extra: any = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => { assert.ok(id in modules, `Unexpected import ${id}`); return modules[id]; }, ...extra });
  return exports;
}
export const anything: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : anything, apply: () => anything });
export const jsx = (type: any, props: any) => ({ type, props });
export function hooks() {
  let cursor = 0; const slots: any[] = [], effects: any[] = [];
  let focusCb: any = null, focusCleanup: any = null;
  const react = {
    useState: (v: any) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof v === 'function' ? v() : v; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef: (v: any) => { const i = cursor++; return slots[i] ??= { current: v }; }, useCallback: (f: any) => f,
    useEffect: (f: any, deps: any[]) => { const i = cursor++; const old = effects[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) effects[i] = { deps, pending: f, cleanup: old?.cleanup }; },
  };
  return { react, render: (fn: any) => { cursor = 0; const tree = fn(); for (const effect of effects) if (effect?.pending) { effect.cleanup?.(); const f = effect.pending; effect.pending = null; effect.cleanup = f(); } return tree; },
    unmount: () => { for (const e of effects) e?.cleanup?.(); },
    useFocusEffect: (cb: any) => { focusCb = cb; },
    focus: () => { if (focusCb) focusCleanup = focusCb(); },
    blur: () => { if (focusCleanup) { focusCleanup(); focusCleanup = null; } } };
}
export function nodes(n: any): any[] { return n && typeof n === 'object' ? [n, ...[n.props?.children, n.props?.right].flat(Infinity).flatMap(nodes)] : []; }
export function text(n: any): string { return [n].flat(Infinity).map((v) => typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' ? text(v.props?.children) : '').join(' '); }
export function button(n: any, title: string) { const b = nodes(n).find((x) => x.props?.title === title && x.props.onPress); assert.ok(b, `Missing ${title}`); return b.props.onPress; }
export async function tick() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
export const server: any = { id: 's', deviceId: 'd', url: 'https://example.invalid', bot: { title: 'Main' } };
export const updates: any = { hermes: {}, winglet: { version: '0.10.5', current: '0.10.5', latest: '0.10.6', update_available: true, latest_release: { version: '0.10.6', tag: 'v0.10.6', sha: 'a'.repeat(40), notes: 'Release details', url: 'https://example.invalid/release', requires_hermes: '>=0.22.7' }, requires_hermes_ok: true, busy: { bots: [], unknown: false } }, checked_at: 1 };
export function network() {
  let release: any, failure: any, preflight = updates; const requests: any[] = [], prompts: string[] = [], checks: string[] = [];
  class ApiError extends Error { status: number; data: any; constructor(message: string, status: number, data?: any) { super(message); this.status = status; this.data = data; } }
  const api = { ApiError, api: async (_s: any, path: string) => { checks.push(path); return path.startsWith('/api/system/updates') ? preflight : { jobs: [] }; },
    signedApi: async (...args: any[]) => { requests.push(args); if (failure) throw failure; return { job: { id: 'job', kind: 'winglet_update', device_id: 'd', created_at: 1, updated_at: 1, state: 'running', detail: {} } }; } };
  const disk = new Map();
  const zustand = { create: (init: any) => { let state: any; const store: any = (select: any) => select(state); const set = (p: any) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; }; state = init(set); store.getState = () => state; store.setState = set; return store; } };
  const jobs = load('lib/updateJobs.ts', { zustand, './api': api, './cache': { cacheGet: async (key: string, fallback: any) => disk.get(key) ?? fallback, cacheSetStrict: async (key: string, value: any) => { disk.set(key, value); } }, './updateRecovery': load('lib/updateRecovery.ts', {}) });
  const core = load('lib/serverUpdates.ts', { './updateJobs': jobs, './api': api, './appLock': { unlock: (prompt: string) => { prompts.push(prompt); return new Promise((r) => { release = r; }); } }, './control': { idempotencyKey: () => 'key' }, zustand });
  return { core, jobs, disk, api, requests, prompts, checks, setUpdates: (value: any) => { preflight = value; }, resolve: (ok: boolean) => release(ok), fail: (status: number, message: string, data?: any) => { failure = new ApiError(message, status, data); } };
}
