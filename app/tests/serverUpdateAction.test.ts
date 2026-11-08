import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

export function actionHarness() {
  let answer: (value: boolean) => void = () => {}, valid = true, failure: any = null;
  const requests: any[] = [], prompts: string[] = [];
  class ApiError extends Error { status: number; data: any; constructor(message: string, status: number, data?: any) { super(message); this.status = status; this.data = data; } }
  const modules: any = {
    './updateJobs': { updateRecovery: { begin: async () => {}, track: async () => {}, clearPending: async () => {}, markUnknown: async () => {} } },
    './appLock': { unlock: (prompt: string) => { prompts.push(prompt); return new Promise<boolean>((resolve) => { answer = resolve; }); } },
    './api': { ApiError, signedApi: async (...args: any[]) => { requests.push(args); if (failure) throw failure; return { job: { id: 'job-1' } }; }, api: async () => ({ winglet: {} }) },
    './control': { idempotencyKey: () => 'request-key' },
    zustand: { create: (init: any) => { let state: any; const hook: any = (select: any) => select(state); state = init((patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; }, () => state); hook.getState = () => state; return hook; } },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/serverUpdates.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => { assert.ok(id in modules, id); return modules[id]; } });
  return { ...exports, requests, prompts, resolve: (ok: boolean) => answer(ok), invalidate: () => { valid = false; }, guard: () => valid,
    fail: (status: number, text: string, data?: any) => { failure = new ApiError(text, status, data); } };
}
const server = { id: 's', deviceId: 'd' };
async function tick() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('server update awaits unlock before sending the exact version and idempotency key', async () => {
  const h = actionHarness(); const pending = h.updateServerWinglet(server, '0.10.6');
  await tick(); assert.deepEqual(h.prompts, ['Update the server']); assert.equal(h.requests.length, 0, 'no request while authentication is pending');
  h.resolve(true); const job = await pending; assert.equal(job.id, 'job-1');
  const [actualServer, method, path, body] = h.requests[0]; assert.equal(actualServer, server); assert.equal(method, 'POST'); assert.equal(path, '/api/system/update');
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { target: 'winglet', version: '0.10.6', idempotency_key: 'request-key' });
});
test('failed or cancelled unlock sends absolutely no server update request', async () => {
  const h = actionHarness(); const pending = h.updateServerWinglet(server, '0.10.6'); h.resolve(false);
  assert.equal(await pending, null); assert.equal(h.requests.length, 0);
});
test('eligibility lost during authentication cancels the update', async () => {
  const h = actionHarness(); const pending = h.updateServerWinglet(server, '0.10.6', h.guard); h.invalidate(); h.resolve(true);
  assert.equal(await pending, null); assert.equal(h.requests.length, 0);
});
for (const status of [400, 409, 503]) test(`server ${status} error text is preserved for the UI`, async () => {
  const h = actionHarness(); h.fail(status, `Server refusal ${status}`); const pending = h.updateServerWinglet(server, '0.10.6'); h.resolve(true);
  await assert.rejects(pending, (e: any) => e.status === status && e.message === `Server refusal ${status}`);
});
