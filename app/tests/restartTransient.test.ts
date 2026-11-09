import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { load, server } from './helpers/serverUpdateHarness.ts';

/** A plugin install restarts the gateway: the phone must ride that out, not report a failure. */
function apiHarness(responses: Array<{ status: number; body?: any }>) {
  const calls: any[] = [];
  const modules: any = {
    'react-native': { Platform: { OS: 'web' } },
    'expo/fetch': { fetch: async (url: string, init: any) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body ?? {} };
    } },
    './crypto': { newSigningKey: () => ({ secret: 's', public: 'p' }), checkServerKey: () => {}, seal: () => '', signedHeaders: () => ({}) },
    './storage': { getItem: async () => null, setItem: async () => {} },
    './verify': { useVerify: { getState: () => ({ ask: () => {} }) } },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: (n: string) => modules[n], URL, URLSearchParams, AbortController, setTimeout, clearTimeout, FormData, Date, JSON, Error });
  return { api: exports, calls };
}

test('a read rides through the gateway restart instead of failing the update', async () => {
  const h = apiHarness([{ status: 502 }, { status: 502 }, { status: 200, body: { ok: true } }]);
  assert.deepEqual(await h.api.request('https://box.example/api/updates'), { ok: true });
  assert.equal(h.calls.length, 3, 'the two 502s are retried, the answer is used');
});

test('a write is never retried: the job is created once, not twice', async () => {
  const h = apiHarness([{ status: 502 }]);
  await assert.rejects(() => h.api.request('https://box.example/api/system/restart', { method: 'POST', body: '{}' }),
    (e: any) => e.status === 502);
  assert.equal(h.calls.length, 1);
});

test('only a front-of-gateway 5xx counts as transient', () => {
  const { api } = apiHarness([{ status: 200 }]);
  for (const status of [502, 503, 504]) assert.equal(api.isTransientServerError(new api.ApiError('x', status)), true);
  for (const status of [500, 404, 401, 0]) assert.equal(api.isTransientServerError(new api.ApiError('x', status)), false);
  assert.equal(api.isTransientServerError(new Error('nope')), false);
});

// -- the handoff notices the restart instead of showing "Server returned 502" -------------------

const update = { version: '0.10.9', page: 'https://github.com/XxeS2K1/winglet/releases/tag/v0.10.9', apk: 'https://example.invalid/winglet.apk' };
const transient = () => Object.assign(new Error('Server returned 502'), { status: 502 });

function harness(disk = { value: null as any }, recover: ((...args: any[]) => Promise<any>) = async () => undefined,
                 clock = { now: 1_000_000 }) {
  let context: any = { server, role: 'owner', online: true, foreground: true, locked: false, current: '0.10.8' };
  let pluginVersion = '0.10.8';
  // The 90s patience is measured with Date.now(), so the test owns that clock.
  class Clock extends Date { static now() { return clock.now; } }
  const { UnifiedUpdate } = load('lib/unifiedUpdate.ts', { './version': load('lib/version.ts', {}),
    './updateRecovery': load('lib/updateRecovery.ts', {}), './api': { isTransientServerError: (e: any) => !!e && [502, 503, 504].includes(e.status) } },
  { Date: Clock });
  const state = { recover };
  const deps: any = {
    read: async () => structuredClone(disk.value), write: async (value: any) => { disk.value = structuredClone(value); },
    context: () => context, authenticate: async () => true, key: () => 'consented-key',
    install: async () => 'opened', abort: () => {},
    system: async () => ({ version: pluginVersion }),
    send: async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 }),
    recover: (...args: any[]) => state.recover(...args), acknowledge: async () => {},
  };
  const controller = new UnifiedUpdate(deps);
  return { controller, disk, context: (patch: any) => { context = { ...context, ...patch }; },
    setRecover: (fn: () => Promise<any>) => { state.recover = fn; }, plugin: (v: string) => { pluginVersion = v; } };
}

test('a 502 while the job runs reads as a restart, not an error, and clears when the server answers', async () => {
  const h = harness();
  await h.controller.start(update);
  const tracking = h; tracking.context({ current: update.version });
  await tracking.controller.observe();
  assert.equal(h.disk.value.stage, 'opened');

  tracking.setRecover(async () => { throw transient(); });
  await tracking.controller.observe();
  assert.equal(tracking.controller.error, '', 'a restart must not be reported as a failed update');
  assert.match(tracking.controller.notice, /restarting to finish the update/i);
  assert.equal(h.disk.value.stage, 'opened', 'the saved stage is kept so the next poll carries on');

  tracking.setRecover(async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'succeeded', detail: {}, updated_at: 2, created_at: 1 }));
  await tracking.controller.observe();
  assert.equal(tracking.controller.notice, '', 'the notice clears once the server answers');
  assert.equal(h.disk.value.stage, 'complete');
});

test('a definite failure is still reported as an error while the job runs', async () => {
  const h = harness();
  await h.controller.start(update);
  h.context({ current: update.version });
  await h.controller.observe();
  h.setRecover(async () => { throw Object.assign(new Error('Server returned 400'), { status: 400 }); });
  await h.controller.observe();
  assert.equal(h.controller.notice, '', 'only a restart is softened');
  assert.match(h.controller.error, /400/);
});

test('a server that stays down reports an error and never falls back to the restart notice', async () => {
  const clock = { now: 1_000_000 };
  const h = harness(undefined, undefined, clock);
  await h.controller.start(update);
  h.context({ current: update.version });
  await h.controller.observe();
  assert.equal(h.disk.value.stage, 'opened');

  h.setRecover(async () => { throw transient(); });
  await h.controller.observe();
  assert.match(h.controller.notice, /restarting to finish the update/i);

  clock.now += 91_000;
  await h.controller.observe();
  assert.equal(h.controller.notice, '', 'patience expired: stop claiming a restart');
  assert.match(h.controller.error, /has not answered/i);

  // The regression the reviewer found: the window used to re-arm here and the notice came back.
  clock.now += 1_000;
  await h.controller.observe();
  assert.equal(h.controller.notice, '', 'the window must not start again');
  assert.match(h.controller.error, /has not answered/i);

  // When the server answers, the error clears and the next restart starts a fresh window.
  h.setRecover(async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 2, created_at: 1 }));
  await h.controller.observe();
  assert.equal(h.controller.error, '');
});
