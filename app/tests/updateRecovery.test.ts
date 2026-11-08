import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, server } from './helpers/serverUpdateHarness.ts';

const job = (state = 'running', updated_at = 1, id = 'j') => ({ id, kind: 'winglet_update', state, updated_at, created_at: 1, device_id: 'd', detail: { message: state } });
function harness(disk = new Map<string, any>()) {
  let history: any[] = [], response: any = null;
  const paths: string[] = [];
  const { UpdateRecovery } = load('lib/updateRecovery.ts', {});
  const recovery = new UpdateRecovery({
    read: async (key: string) => structuredClone(disk.get(key) ?? null),
    write: async (key: string, value: any) => { disk.set(key, structuredClone(value)); },
    fetch: async (_s: any, path: string) => { paths.push(path); return path === '/api/system' ? { jobs: history } : { job: response }; },
  });
  return { recovery, disk, paths, history: (v: any[]) => { history = v; }, response: (v: any) => { response = v; } };
}
test('an unresolved intent cannot be overwritten by another entry point or stale history', async () => {
  const h = harness(); const body = { target: 'winglet', idempotency_key: 'first' };
  await h.recovery.begin(server, body);
  await assert.rejects(h.recovery.begin(server, { target: 'winglet', idempotency_key: 'second' }));
  await h.recovery.track(server, job('failed', 1, 'old'));
  assert.equal(h.recovery.snapshot(server).pending.idempotency_key, 'first');
});
test('rehydrates unacknowledged progress and recovers terminal history on reconnect', async () => {
  const h = harness(); await h.recovery.track(server, job());
  const next = harness(h.disk); await next.recovery.hydrate(server);
  assert.equal(next.recovery.snapshot(server).jobs[0].state, 'running');
  next.history([job('failed', 2)]); next.response(job('failed', 2)); await next.recovery.refresh(server);
  assert.equal(next.recovery.snapshot(server).jobs[0].state, 'failed');
  await next.recovery.acknowledge(server, 'j');
  const third = harness(h.disk); third.history([job('failed', 2)]); await third.recovery.refresh(server);
  assert.equal(third.recovery.snapshot(server).jobs.length, 0);
});
test('running jobs cannot be acknowledged; terminal results require acknowledgement', async () => {
  const h = harness(); await h.recovery.track(server, job()); await h.recovery.acknowledge(server, 'j');
  assert.equal(h.recovery.snapshot(server).jobs.length, 1);
  await h.recovery.track(server, job('succeeded', 2));
  const next = harness(h.disk); await next.recovery.hydrate(server); assert.equal(next.recovery.snapshot(server).jobs[0].state, 'succeeded');
});
test('history recovers dropped POST response without new endpoints or another install', async () => {
  const h = harness(); await h.recovery.begin(server, { target: 'winglet', version: '0.10.7', idempotency_key: 'same' });
  const next = harness(h.disk); next.history([job('succeeded', 2)]); await next.recovery.refresh(server);
  assert.equal(next.recovery.snapshot(server).jobs[0].state, 'succeeded');
  assert.ok(next.paths.includes('/api/system'));
});
test('known job lookup still recovers when the system history request fails', async () => {
  const h = harness(); await h.recovery.track(server, job());
  h.recovery.deps.fetch = async (_s: any, path: string) => {
    if (path === '/api/system') throw new Error('health unavailable');
    return { job: job('failed', 3) };
  };
  await h.recovery.refresh(server);
  assert.equal(h.recovery.snapshot(server).jobs[0].state, 'failed');
});
test('scopes history and durable data to server URL and device and excludes APK/other jobs', async () => {
  const h = harness(); h.history([job(), { ...job('running', 1, 'foreign'), device_id: 'other' }, { ...job('running', 1, 'skill'), kind: 'skill_install' }]);
  await h.recovery.refresh(server); assert.equal(h.recovery.snapshot(server).jobs.length, 1);
  for (const other of [{ ...server, deviceId: 'other' }, { ...server, url: 'https://other.invalid' }, { ...server, id: 'other' }]) {
    await h.recovery.hydrate(other); assert.equal(h.recovery.snapshot(other).jobs.length, 0);
  }
});
test('an old server response arriving after a device switch cannot populate the new pairing', async () => {
  const h = harness(); let reply: any;
  h.recovery.deps.fetch = (_s: any, path: string) => path === '/api/system' ? new Promise((resolve) => { reply = resolve; }) : Promise.resolve({ job: job('failed', 2) });
  const pending = h.recovery.refresh(server);
  for (let i = 0; i < 20 && !reply; i++) await Promise.resolve();
  assert.ok(reply, 'history request started');
  const other = { ...server, deviceId: 'new' }; await h.recovery.hydrate(other);
  reply({ jobs: [job('failed', 2)] }); await pending;
  assert.equal(h.recovery.snapshot(other).jobs.length, 0);
  assert.equal(h.recovery.snapshot(server).jobs[0].state, 'failed');
});
test('stale polls and replay cannot revert a terminal result or resurrect acknowledgement', async () => {
  const h = harness(); await h.recovery.track(server, job('succeeded', 5));
  await h.recovery.track(server, job('running', 9)); assert.equal(h.recovery.snapshot(server).jobs[0].state, 'succeeded');
  await h.recovery.acknowledge(server, 'j'); await h.recovery.track(server, job('failed', 10));
  assert.equal(h.recovery.snapshot(server).jobs.length, 0);
});
