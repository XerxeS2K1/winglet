import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, server } from './helpers/serverUpdateHarness.ts';

const update = { version: '0.10.8', page: 'https://github.com/XerxeS2K1/winglet/releases/tag/v0.10.8', apk: 'https://example.invalid/winglet.apk' };
function harness(disk = { value: null as any }) {
  let context: any = { server, role: 'owner', online: true, foreground: true, locked: false, current: '0.10.7' };
  const sent: any[] = [], installs: any[] = [], prompts: string[] = [];
  let pluginVersion = '0.10.7';
  const { UnifiedUpdate } = load('lib/unifiedUpdate.ts', { './version': load('lib/version.ts', {}), './updateRecovery': load('lib/updateRecovery.ts', {}), './api': { isTransientServerError: (e: any) => !!e && (e.status === 502 || e.status === 503 || e.status === 504) } });
  const deps: any = {
    read: async () => structuredClone(disk.value), write: async (value: any) => { disk.value = structuredClone(value); },
    context: () => context, authenticate: async (prompt: string) => { prompts.push(prompt); return true; },
    key: () => 'consented-key', install: async (...args: any[]) => { installs.push(args); return 'opened'; }, abort: () => {},
    system: async () => ({ version: pluginVersion, jobs: [] }),
    send: async (...args: any[]) => { sent.push(args); return { id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 }; },
    recover: async () => {}, acknowledge: async () => {},
  };
  const controller = new UnifiedUpdate(deps);
  return { controller, deps, disk, sent, installs, prompts, context: (patch: any) => { context = { ...context, ...patch }; }, plugin: (value: string) => { pluginVersion = value; } };
}

test('one authenticated Update tap sends the server job first, then opens the Android installer', async () => {
  const h = harness();
  await h.controller.start(update);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0].url, server.url);
  assert.equal(h.sent[0][1].version, update.version);
  assert.equal(h.sent[0][1].idempotency_key, 'consented-key');
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'opened');
  assert.equal(h.disk.value.jobId, 'job');
  assert.match(h.disk.value.message, /server is already updating/i);
});

test('a 4xx server refusal fails the update and never opens the installer', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw Object.assign(new Error('Server refused'), { status: 409 }); };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 0);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /refused|could not be started/i);
});

test('a 5xx server reply still opens the installer and leaves the job recoverable afterwards', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw Object.assign(new Error('Server returned 502'), { status: 502 }); };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'opened');
  assert.equal(h.disk.value.jobId, undefined);
  assert.match(h.disk.value.message, /already updating/i);
  const next = harness(h.disk);
  next.context({ current: update.version });
  next.deps.recover = async () => ({ id: 'recovered', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 });
  await next.controller.observe();
  assert.equal(next.disk.value.stage, 'tracking');
  assert.equal(next.disk.value.jobId, 'recovered');
});

test('cancelling the Android install after the job was sent reports the server was already updated', async () => {
  const h = harness();
  h.deps.install = async (...args: any[]) => { h.installs.push(args); return 'cancelled'; };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'cancelled');
  assert.match(h.disk.value.message, /server plugin was already updated/i);
});

test('an app download failure after the job was sent reports the server was already updated', async () => {
  const h = harness();
  h.deps.install = async (...args: any[]) => { h.installs.push(args); return 'error'; };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /server plugin was already updated/i);
});

test('startup without a saved tap cannot install either part', async () => {
  const h = harness();
  await h.controller.observe();
  assert.equal(h.sent.length, 0);
  assert.equal(h.installs.length, 0);
  assert.equal(h.prompts.length, 0);
});

for (const role of ['member', undefined]) test(`unconfirmed/non-owner ${role} consent is app-only`, async () => {
  const h = harness();
  h.context({ role });
  await h.controller.start(update);
  assert.equal(h.disk.value, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.installs.length, 1);
});

test('no server is app-only; a subsequently paired server gets no inherited consent', async () => {
  const h = harness();
  h.context({ server: undefined, role: undefined });
  await h.controller.start(update);
  assert.equal(h.disk.value, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.installs.length, 1);
});

test('a non-owner app install failure is reported locally and never starts a server step', async () => {
  const h = harness();
  h.context({ role: 'member' });
  h.deps.install = async () => 'error';
  await h.controller.start(update);
  assert.equal(h.sent.length, 0);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /app update could not be downloaded/i);
});

test('a lost server reply (status 0) still opens the installer and is recovered later', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw Object.assign(new Error('lost'), { status: 0 }); };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'opened');
  assert.equal(h.disk.value.jobId, undefined);
});

test('a crash before the server reply leaves a dispatching record that is recovered, not reposted', async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'dispatching';
  h.disk.value.jobId = undefined;
  const next = harness(h.disk);
  next.context({ current: update.version });
  next.deps.recover = async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'tracking');
});

test('server refusal is visible and never falls forward to a newer unrelated release', async () => {
  const h = harness();
  h.deps.send = async () => { throw Object.assign(new Error('0.10.9 is newest; requested 0.10.8 refused'), { status: 409 }); };
  await h.controller.start(update);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /requested 0.10.8 refused/i);
  assert.equal(h.installs.length, 0);
});

test('a newer app than the consented release retires the server step instead of installing an older plugin', async () => {
  const h = harness();
  await h.controller.start(update);
  const next = harness(h.disk);
  next.context({ current: '0.10.9' });
  next.deps.recover = async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'succeeded', detail: {}, updated_at: 1, created_at: 1 });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'complete');
  assert.match(next.disk.value.message, /cancelled/i);
});

test('authentication cancellation has no durable handoff or download and tells the user', async () => {
  const h = harness();
  h.deps.authenticate = async () => false;
  await h.controller.start(update);
  assert.equal(h.disk.value, null);
  assert.equal(h.installs.length, 0);
  assert.equal(h.sent.length, 0);
  assert.match(h.controller.error, /needs your approval/i);
});

for (const version of ['0.10.7', '0.9.0', 'garbage']) test(`stale or malformed app offer ${version} cannot create server consent`, async () => {
  const h = harness();
  await h.controller.start({ ...update, version });
  assert.equal(h.installs.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.disk.value, null);
});

test('a saved job missing from history stays open so a gateway restart is not mistaken for failure', async () => {
  const h = harness();
  await h.controller.start(update);
  const next = harness(h.disk);
  next.context({ current: update.version });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'opened');
  await next.controller.cancel();
  assert.equal(next.disk.value, null);
});

test('opening a release page without an APK carries no server authorization', async () => {
  const h = harness();
  await h.controller.start({ ...update, apk: undefined });
  assert.equal(h.disk.value, null);
  assert.equal(h.sent.length, 0);
});

test('an unreadable read failure is clearable and never blocks a fresh consented update', async () => {
  const h = harness();
  h.deps.read = async () => { throw new SyntaxError('Unexpected token'); };
  await assert.rejects(() => h.controller.hydrate(), /Unexpected token/);
  assert.match(h.controller.notice, /Unexpected token/);
  await h.controller.resetUnreadable();
  assert.equal(h.controller.record, null);
  assert.equal(h.controller.notice, '');
  await h.controller.start(update);
  assert.equal(h.disk.value.stage, 'opened');
  assert.equal(h.installs.length, 1);
  assert.equal(h.sent.length, 1);
});

test('overlapping polls cannot burn one consent into a false failure', async () => {
  const h = harness();
  await h.controller.start(update);
  const next = harness(h.disk);
  next.context({ current: update.version });
  next.deps.recover = async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 });
  await Promise.all([next.controller.observe(), next.controller.observe()]);
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'tracking');
});

test('history recovery only considers jobs created after the saved consent', async () => {
  const h = harness();
  await h.controller.start(update);
  const next = harness(h.disk);
  next.context({ current: update.version });
  let args: any[] = [];
  next.deps.recover = async (...a: any[]) => { args = a; return undefined; };
  next.disk.value.stage = 'tracking';
  next.disk.value.jobId = undefined;
  await next.controller.observe();
  assert.equal(args[3], next.disk.value.created);
});

test('a running historical job is linked so its progress is visible', async () => {
  const h = harness();
  await h.controller.start(update);
  const next = harness(h.disk);
  next.context({ current: update.version });
  next.deps.recover = async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 });
  await next.controller.observe();
  assert.equal(next.disk.value.stage, 'tracking');
  assert.equal(next.disk.value.jobId, 'job');
});

test('a scoped record is not cleared locally while the owner role is unknown', async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'failed';
  const next = harness(h.disk);
  next.context({ current: update.version, role: undefined, online: true });
  await next.controller.done();
  assert.equal(next.disk.value.stage, 'failed');
});

test('a scoped record can be closed locally when the server is unreachable', async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'failed';
  const next = harness(h.disk);
  next.context({ current: update.version, role: undefined, online: false });
  await next.controller.done();
  assert.equal(next.disk.value, null);
});

test('a transient read failure does not overwrite a valid saved handoff', async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'tracking';
  h.disk.value.jobId = 'job';
  const next = harness(h.disk);
  let reads = 0;
  next.deps.read = async () => { reads += 1; if (reads === 1) throw new Error('transient'); return structuredClone(next.disk.value); };
  await next.controller.start(update);
  assert.equal(reads, 2);
  assert.equal(next.disk.value.stage, 'tracking');
  assert.match(next.controller.error, /Finish or cancel/);
});

test('a fresh start is rejected while a server-first update is in progress', async () => {
  const h = harness();
  await h.controller.start(update);
  const second = harness(h.disk);
  await second.controller.start(update);
  assert.match(second.controller.error, /Finish or cancel/);
});

