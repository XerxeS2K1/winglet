import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, server } from './helpers/serverUpdateHarness.ts';

const update = { version: '0.10.8', page: 'https://github.com/XerxeS2K1/winglet/releases/tag/v0.10.8', apk: 'https://example.invalid/winglet.apk' };
function harness(disk = { value: null as any }) {
  let context: any = { server, role: 'owner', online: true, foreground: true, locked: false, current: '0.10.7' };
  const sent: any[] = [], installs: any[] = [], prompts: string[] = [];
  let pluginVersion = '0.10.7';
  const { UnifiedUpdate } = load('lib/unifiedUpdate.ts', { './version': load('lib/version.ts', {}), './updateRecovery': load('lib/updateRecovery.ts', {}) });
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
test('one authenticated Update tap persists a matching handoff, but opening Android installer never updates the plugin', async () => {
  const h = harness(); await h.controller.start(update); assert.equal(h.prompts.length, 1); assert.equal(h.installs.length, 1);
  assert.equal(h.sent.length, 0); assert.equal(h.disk.value.stage, 'awaiting-app');
  await h.controller.observe(); assert.equal(h.sent.length, 0, 'old app returning from cancelled installer is not proof');
  const next = harness(h.disk); next.context({ current: '0.10.8' }); await next.controller.observe();
  assert.equal(next.sent.length, 1); assert.equal(next.sent[0][0].url, server.url);
  assert.equal(next.sent[0][1].version, update.version); assert.equal(next.sent[0][1].idempotency_key, 'consented-key');
  assert.equal(next.prompts.length, 0, 'the saved one-tap consent authorizes only this handoff');
  assert.equal(next.disk.value.stage, 'tracking'); assert.equal(next.disk.value.jobId, 'job');
});
test('startup without a saved tap cannot install either part', async () => {
  const h = harness(); await h.controller.observe(); assert.equal(h.sent.length, 0); assert.equal(h.installs.length, 0); assert.equal(h.prompts.length, 0);
});
for (const role of ['member', undefined]) test(`unconfirmed/non-owner ${role} consent is app-only even if later promoted`, async () => {
  const h = harness(); h.context({ role }); await h.controller.start(update); assert.equal(h.disk.value.scope, undefined);
  const next = harness(h.disk); next.context({ role: 'owner', current: update.version }); await next.controller.observe();
  assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'complete');
});
test('no server is app-only; a subsequently paired server gets no inherited consent', async () => {
  const h = harness(); h.context({ server: undefined, role: undefined }); await h.controller.start(update);
  const next = harness(h.disk); next.context({ current: update.version }); await next.controller.observe(); assert.equal(next.sent.length, 0);
});
for (const version of ['0.10.8', '0.11.0']) test(`server already on ${version} is never installed or downgraded`, async () => {
  const h = harness(); await h.controller.start(update); const next = harness(h.disk); next.context({ current: update.version }); next.plugin(version);
  await next.controller.observe(); assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'complete');
});
for (const context of [{ server: { ...server, url: 'https://moved.invalid' } }, { server: { ...server, deviceId: 'new-device' } }, { server: { ...server, id: 'other' } }, { role: 'member' }, { role: undefined }, { online: false }, { foreground: false }, { locked: true }]) test(`saved consent waits for its exact owner pairing: ${JSON.stringify(context)}`, async () => {
  const h = harness(); await h.controller.start(update); const next = harness(h.disk); next.context({ current: update.version, ...context });
  await next.controller.observe(); assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'awaiting-app');
});
test('saved consent never uses a role acquired after the one-tap consent', async () => {
  const h = harness(); h.context({ role: 'member' }); await h.controller.start(update);
  assert.equal(h.disk.value.scope, undefined);
  const next = harness(h.disk); next.context({ role: 'owner', current: update.version });
  await next.controller.observe(); assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'complete');
});
test('a handoff saved with a server scope and no owner role is rejected as unreadable', async () => {
  const h = harness(); h.disk.value = { version: update.version, key: 'consented-key', scope: 'saved-scope', stage: 'awaiting-app', message: 'saved' };
  await assert.rejects(() => h.controller.hydrate(), /cannot be read/);
});
test('a download failure says download, not installer, and never starts the server step', async () => {
  const h = harness(); h.deps.install = async () => 'error'; await h.controller.start(update);
  assert.equal(h.disk.value.stage, 'failed'); assert.match(h.disk.value.message, /downloaded or opened/i);
  assert.equal(h.sent.length, 0);
});
test('a dispatch that already has a server update fails clearly instead of claiming a lost reply', async () => {
  const h = harness(); await h.controller.start(update); h.context({ current: update.version });
  h.deps.send = async () => { throw new Error('An update is already being tracked.'); };
  await h.controller.observe(); assert.equal(h.disk.value.stage, 'failed');
  assert.match(h.disk.value.message, /already being tracked/i);
  assert.doesNotMatch(h.disk.value.message, /reply was lost/i);
});
test('an error notice is kept until the user dismisses it and never discards a live record', async () => {
  const h = harness(); await h.controller.start(update); h.context({ current: update.version });
  h.deps.system = async () => { throw new Error('Network request failed'); };
  await h.controller.observe(); assert.match(h.controller.error, /Network request failed/);
  await h.controller.observe(); assert.match(h.controller.error, /Network request failed/);
  h.controller.clearError(); assert.equal(h.controller.error, ''); assert.equal(h.disk.value.stage, 'awaiting-app');
});
test('an orphaned saved consent can be cleared so the app stays updateable', async () => {
  const h = harness(); await h.controller.start(update); h.context({ current: '0.10.7', server: { ...server, id: 'moved' } });
  assert.equal(h.controller.record.stage, 'awaiting-app');
  await h.controller.recoverOrphan(); assert.equal(h.controller.record, null); assert.equal(h.disk.value, null);
});
test('an orphan can be acknowledged once the consented app version is actually running', async () => {
  const h = harness(); await h.controller.start(update); h.context({ current: update.version, server: { ...server, id: 'moved' } });
  await h.controller.recoverOrphan(); assert.equal(h.controller.record.stage, 'awaiting-app');
  await h.controller.acknowledgeOrphan(); assert.equal(h.controller.record, null);
});
test('double taps share one authentication and download; switching away and back during auth invalidates it', async () => {
  const h = harness(); let resolve: any; h.deps.authenticate = () => new Promise((r) => { resolve = r; });
  const pending = h.controller.start(update); for (let i = 0; i < 10; i++) await Promise.resolve();
  await h.controller.start(update); h.controller.invalidate(); resolve(true); await pending;
  assert.equal(h.installs.length, 0); assert.equal(h.disk.value, null);
});
test('cancelling an installer handoff prevents a later matching app from updating the server', async () => {
  const h = harness(); await h.controller.start(update); await h.controller.cancel();
  const next = harness(h.disk); next.context({ current: update.version }); await next.controller.observe(); assert.equal(next.sent.length, 0);
});
test('durable storage failure prevents opening the APK installer', async () => {
  const h = harness(); h.deps.write = async () => { throw new Error('storage unavailable'); }; await h.controller.start(update);
  assert.equal(h.installs.length, 0); assert.equal(h.sent.length, 0); assert.match(h.controller.error, /storage unavailable/);
});
test('download/installer failure never starts the plugin', async () => {
  const h = harness(); h.deps.install = async () => 'error'; await h.controller.start(update); assert.equal(h.disk.value.stage, 'failed');
  h.context({ current: update.version }); await h.controller.observe(); assert.equal(h.sent.length, 0);
});
test('lost server reply stays unknown across reconnect/relaunch and never repeats a POST', async () => {
  const h = harness(); await h.controller.start(update); const next = harness(h.disk); next.context({ current: update.version });
  next.deps.send = async () => { throw Object.assign(new Error('lost'), { status: 0 }); }; await next.controller.observe(); assert.equal(next.disk.value.stage, 'unknown');
  const again = harness(h.disk); again.context({ current: update.version }); await again.controller.observe(); await again.controller.observe();
  assert.equal(again.sent.length, 0); assert.equal(again.disk.value.stage, 'unknown');
});
test('a crash before the server reply cannot turn a persisted dispatch into a fresh installation', async () => {
  const h = harness(); await h.controller.start(update); h.disk.value.stage = 'dispatching';
  const next = harness(h.disk); next.context({ current: update.version }); await next.controller.observe(); assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'unknown');
});
test('server refusal is visible and never falls forward to a newer unrelated release', async () => {
  const h = harness(); await h.controller.start(update); const next = harness(h.disk); next.context({ current: update.version });
  next.deps.send = async () => { throw Object.assign(new Error('0.10.9 is newest; requested 0.10.8 refused'), { status: 409 }); };
  await next.controller.observe(); assert.equal(next.disk.value.stage, 'failed'); assert.match(next.disk.value.message, /requested 0.10.8 refused/);
  await next.controller.observe(); assert.equal(next.sent.length, 0);
});
test('a newer app than the consented release retires the server step instead of installing an older plugin', async () => {
  const h = harness(); await h.controller.start(update); const next = harness(h.disk); next.context({ current: '0.10.9' }); await next.controller.observe();
  assert.equal(next.sent.length, 0); assert.equal(next.disk.value.stage, 'complete'); assert.match(next.disk.value.message, /cancelled/);
});
test('authentication cancellation has no durable handoff or download and tells the user', async () => {
  const h = harness(); h.deps.authenticate = async () => false; await h.controller.start(update);
  assert.equal(h.disk.value, null); assert.equal(h.installs.length, 0);
  assert.match(h.controller.error, /needs your approval/i);
});
for (const version of ['0.10.7', '0.9.0', 'garbage']) test(`stale or malformed app offer ${version} cannot create server consent`, async () => {
  const h = harness(); await h.controller.start({ ...update, version }); assert.equal(h.installs.length, 0); assert.equal(h.disk.value, null);
});
test('a saved job missing from history becomes explicitly unknown, not an undismissable running result', async () => {
  const h = harness(); await h.controller.start(update); h.disk.value.stage = 'tracking'; h.disk.value.jobId = 'missing';
  const next = harness(h.disk); next.context({ current: update.version }); await next.controller.observe();
  assert.equal(next.disk.value.stage, 'unknown'); assert.equal(next.sent.length, 0);
  await next.controller.done(); assert.equal(next.disk.value, null);
});
test('opening a release page without an APK carries no server authorization', async () => {
  const h = harness(); await h.controller.start({ ...update, apk: undefined }); assert.equal(h.disk.value, null); assert.equal(h.sent.length, 0);
});

