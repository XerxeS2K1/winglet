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

test('a download failure says download, not installer, and never starts the server step', async () => {
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

test('a saved job missing from history becomes explicitly unknown, not an undismissable running result', async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'tracking';
  h.disk.value.jobId = 'missing';
  const next = harness(h.disk);
  next.context({ current: update.version });
  await next.controller.observe();
  assert.equal(next.disk.value.stage, 'unknown');
  assert.equal(next.sent.length, 0);
  await next.controller.done();
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

test('saved consent never uses a role acquired after the one-tap consent', async () => {
  const h = harness();
  h.context({ role: 'member' });
  await h.controller.start(update);
  assert.equal(h.disk.value, null);
  const next = harness(h.disk);
  next.context({ role: 'owner', current: update.version });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value, null);
});

test('a handoff saved with a server scope and no owner role is rejected as unreadable', async () => {
  const h = harness();
  h.disk.value = { version: update.version, key: 'saved-key', scope: 'saved-scope', stage: 'opened', message: 'saved' };
  await assert.rejects(() => h.controller.hydrate(), /cannot be read/);
});

test('a dispatch that already has a server update fails clearly instead of claiming a lost reply', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw new Error('An update is already being tracked.'); };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 0);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /already being tracked/i);
  assert.doesNotMatch(h.disk.value.message, /reply was lost/i);
});

test('a send interrupted by a pairing switch records that nothing was sent', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => {
    // Simulate the pairing switching after the eligibility check but before the POST returns.
    h.context({ role: 'member' });
    throw new Error('The selected connection changed before the server command could be sent.');
  };
  await h.controller.start(update);
  assert.equal(h.sent.length, 0);
  assert.equal(h.installs.length, 0);
  assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /changed|could not be sent/i);
});

test('durable storage failure prevents opening the APK installer and sending the job', async () => {
  const h = harness();
  h.deps.write = async () => { throw new Error('storage unavailable'); };
  await h.controller.start(update);
  assert.equal(h.installs.length, 0);
  assert.equal(h.sent.length, 0);
  assert.match(h.controller.error, /storage unavailable/);
});

test('double taps share one authentication and download; switching away and back during auth invalidates it', async () => {
  const h = harness();
  let resolve: any;
  h.deps.authenticate = () => new Promise((r) => { resolve = r; });
  const pending = h.controller.start(update);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await h.controller.start(update);
  h.controller.invalidate();
  resolve(true);
  await pending;
  assert.equal(h.installs.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.disk.value, null);
});

test('an orphaned saved consent can be cleared so the app stays updateable', async () => {
  const h = harness();
  await h.controller.start(update);
  h.context({ current: '0.10.7', server: { ...server, id: 'moved' } });
  assert.equal(h.controller.record.stage, 'opened');
  await h.controller.recoverOrphan();
  assert.equal(h.controller.record, null);
  assert.equal(h.disk.value, null);
});

test('an orphan can be acknowledged once the consented app version is actually running', async () => {
  const h = harness();
  await h.controller.start(update);
  h.context({ current: update.version, server: { ...server, id: 'moved' } });
  await h.controller.recoverOrphan();
  assert.equal(h.controller.record.stage, 'opened');
  await h.controller.acknowledgeOrphan();
  assert.equal(h.controller.record, null);
});

test('an error notice is kept until the user dismisses it and never discards a live record', async () => {
  const h = harness();
  await h.controller.start(update);
  h.context({ current: update.version });
  h.deps.recover = async () => { throw new Error('Network request failed'); };
  await h.controller.observe();
  assert.match(h.controller.error, /Network request failed/);
  await h.controller.observe();
  assert.match(h.controller.error, /Network request failed/);
  h.controller.clearError();
  assert.equal(h.controller.error, '');
  assert.equal(h.disk.value.stage, 'opened');
});

test('cancelling an installer handoff prevents a later matching app from updating the server', async () => {
  const h = harness();
  await h.controller.start(update);
  await h.controller.cancel();
  const next = harness(h.disk);
  next.context({ current: update.version });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
});

test('a lost server reply never repeats a POST across reconnect/relaunch', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw Object.assign(new Error('lost'), { status: 0 }); };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'opened');
  assert.equal(h.disk.value.jobId, undefined);
  const next = harness(h.disk);
  next.context({ current: update.version });
  await next.controller.observe();
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'opened');
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

for (const context of [
  { name: 'server url changed', patch: { server: { ...server, url: 'https://moved.invalid' } } },
  { name: 'server device changed', patch: { server: { ...server, deviceId: 'new-device' } } },
  { name: 'server id changed', patch: { server: { ...server, id: 'other' } } },
  { name: 'role is member', patch: { role: 'member' } },
  { name: 'server offline', patch: { online: false } },
  { name: 'app in background', patch: { foreground: false } },
  { name: 'device locked', patch: { locked: true } },
]) test(`saved opened consent with no jobId waits for its exact owner pairing: ${context.name}`, async () => {
  const h = harness();
  await h.controller.start(update);
  h.disk.value.stage = 'opened';
  h.disk.value.jobId = undefined;
  const next = harness(h.disk);
  next.context({ current: update.version, ...context.patch });
  await next.controller.observe();
  assert.equal(next.sent.length, 0);
  assert.equal(next.disk.value.stage, 'opened');
});

for (const pluginVersion of ['0.10.8', '0.11.0']) test(`server already on ${pluginVersion} completes when the app install finishes`, async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => {
    h.sent.push(args);
    return { id: 'job', kind: 'winglet_update', device_id: 'd', state: 'succeeded', detail: { to: pluginVersion }, updated_at: 2, created_at: 1 };
  };
  await h.controller.start(update);
  assert.equal(h.sent.length, 1);
  assert.equal(h.installs.length, 1);
  assert.equal(h.disk.value.stage, 'opened');
  const next = harness(h.disk);
  next.context({ current: update.version });
  next.deps.recover = async () => ({ id: 'job', kind: 'winglet_update', device_id: 'd', state: 'succeeded', detail: { to: pluginVersion }, updated_at: 2, created_at: 1 });
  await next.controller.observe();
  assert.equal(next.disk.value.stage, 'complete');
});

test('a 5xx during observe keeps the opened record and shows a restart notice', async () => {
  const h = harness();
  await h.controller.start(update);
  h.context({ current: update.version });
  h.deps.recover = async () => { throw Object.assign(new Error('gateway restart'), { status: 502 }); };
  await h.controller.observe();
  assert.equal(h.disk.value.stage, 'opened');
  assert.match(h.controller.notice, /restarting to finish the update/i);
  assert.equal(h.controller.error, '');
});

test('done() cannot dismiss an opened record while the installer is pending', async () => {
  const h = harness();
  await h.controller.start(update);
  await h.controller.done();
  assert.equal(h.disk.value.stage, 'opened');
});

test('cancel() clears an opened record so the user can start over', async () => {
  const h = harness();
  await h.controller.start(update);
  await h.controller.cancel();
  assert.equal(h.disk.value, null);
});

test('a fresh start is allowed after a terminal failed record is dismissed', async () => {
  const h = harness();
  h.deps.send = async (...args: any[]) => { h.sent.push(args); throw Object.assign(new Error('Server refused'), { status: 409 }); };
  await h.controller.start(update);
  assert.equal(h.disk.value.stage, 'failed');
  const next = harness(h.disk);
  await next.controller.done();
  assert.equal(next.disk.value, null);
  await next.controller.start(update);
  assert.equal(next.disk.value.stage, 'opened');
  assert.equal(next.sent.length, 1);
});

