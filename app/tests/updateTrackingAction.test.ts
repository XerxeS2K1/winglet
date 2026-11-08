import assert from 'node:assert/strict';
import { test } from 'node:test';
import { network, server, tick } from './helpers/serverUpdateHarness.ts';

test('storage failure prevents a POST whose progress could not be recovered', async () => {
  const h = network(); h.jobs.updateRecovery.deps.write = async () => { throw new Error('storage full'); };
  const pending = h.core.updateServerWinglet(server, '0.10.7'); h.resolve(true);
  await assert.rejects(pending, /storage full/); assert.equal(h.requests.length, 0);
});
test('eligibility loss during the durable write sends nothing', async () => {
  const h = network(); let eligible = true;
  const write = h.jobs.updateRecovery.deps.write;
  h.jobs.updateRecovery.deps.write = async (...args: any[]) => { await write(...args); eligible = false; };
  const pending = h.core.updateServerWinglet(server, '0.10.7', () => eligible); h.resolve(true);
  assert.equal(await pending, null); assert.equal(h.requests.length, 0);
});
test('shared action durably records intent before POST and publishes progress for either UI entry', async () => {
  const h = network(); let intentAtSend: any;
  const send = h.api.signedApi;
  h.api.signedApi = async (...args: any[]) => { intentAtSend = [...h.disk.values()].find((v: any) => v.pending); return send(...args); };
  const pending = h.core.updateServerWinglet(server, '0.10.7'); h.resolve(true); await pending;
  assert.equal(intentAtSend?.pending.idempotency_key, 'key');
  assert.equal(h.jobs.updateRecovery.snapshot(server).jobs[0]?.id, 'job');
});
test('transport failure keeps the exact intent for history recovery without automatic repost on remount', async () => {
  const h = network(); h.fail(0, 'reply lost');
  const pending = h.core.updateServerWinglet(server, '0.10.7'); h.resolve(true); await assert.rejects(pending);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0][3], h.requests[1][3]);
  assert.equal(h.jobs.updateRecovery.snapshot(server).pending?.version, '0.10.7');
  await h.jobs.updateRecovery.hydrate(server); await tick(); assert.equal(h.requests.length, 2);
});
