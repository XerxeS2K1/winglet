import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, network, server, hooks, jsx, anything, nodes, text, button, tick } from './helpers/serverUpdateHarness.ts';

const update = { version: '0.10.8', apk: 'https://example.invalid/update.apk', page: 'https://example.invalid/release' };
class MockTimers {
  #interval: ReturnType<typeof setInterval>;
  constructor() { this.#interval = setInterval(() => {}, 2000); }
  async tick(ms: number) { await new Promise((r) => setTimeout(r, ms)); }
  restore() { clearInterval(this.#interval); }
}
function harness(disk = new Map(), current = '0.10.7') {
  const net = network(), events: any[] = [], contextListeners = new Set<() => void>();
  let state: any = { ready: true, foreground: true, servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: 'owner' } } } };
  const useApp: any = (select: any) => select(state); useApp.getState = () => state; useApp.subscribe = (fn: any) => { contextListeners.add(fn); return () => contextListeners.delete(fn); };
  const lock: any = (select: any) => select({ locked: false }); lock.getState = () => ({ locked: false }); lock.subscribe = () => () => {};
  const zustand = { create: (init: any) => { let s: any; const store: any = (select = (v: any) => v) => select(s); store.setState = (p: any) => { s = { ...s, ...p }; }; s = init(store.setState); store.getState = () => s; return store; } };
  const installer: any = () => ({ phase: 'ready', progress: 1, cancel: () => {} }); installer.getState = () => ({ install: async () => { events.push('installer opened'); return 'opened'; }, cancel: () => {} });
  const core = load('lib/unifiedUpdate.ts', { './version': load('lib/version.ts', {}), './updateRecovery': load('lib/updateRecovery.ts', {}) });
  const flow = load('lib/unifiedUpdateFlow.ts', {
    'expo-constants': { expoConfig: { version: current } }, zustand, './api': net.api,
    './cache': { cacheGetStrict: async (key: string) => disk.get(key) ?? null, cacheSetStrict: async (key: string, value: any) => { disk.set(key, structuredClone(value)); } },
    './appInstall': { useAppInstall: installer }, './appUpdateCheck': { appUpdateSupported: true }, './appLock': { unlock: async () => { events.push('authenticate'); return true; }, useLock: lock },
    './store': { useApp }, './control': { idempotencyKey: () => 'handoff-key' }, './serverUpdates': net.core, './updateJobs': net.jobs,
    './unifiedUpdate': core,
  });
  const host = hooks();
  const modules: any = { react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Text: 'Text', View: 'View', Linking: {} },
    'expo-constants': { expoConfig: { version: current } }, '../lib/unifiedUpdateFlow': flow, '../lib/appInstall': { useAppInstall: installer },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: (select: any) => select({ update }) }, '../lib/appLock': { useLock: lock }, '../lib/prefs': { usePrefs: (fn: any) => fn({ prefs: { updateCheck: true } }) },
    '../lib/storage': { getJSON: async () => null }, '../lib/store': { useApp, useServerState: () => state.runtime.s }, '../lib/updateJobs': net.jobs,
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything }, './icons': {}, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button' }, './JobSheet': { JobSheet: 'JobSheet' },
    'expo-router': { usePathname: () => '/' },
  };
  const app = load('components/AppUpdate.tsx', modules), ui = load('components/UnifiedUpdateHost.tsx', modules, { setInterval: () => 1, clearInterval: () => {} });
  return { ...net, flow, disk, events, app, ui, host, modules, render: () => host.render(() => app.InstallButton({ update })),
    progress: () => host.render(() => ui.UnifiedUpdateHost()), prompt: () => host.render(() => app.UpdatePrompt()),
    change: (patch: any) => { state = { ...state, ...patch }; contextListeners.forEach((fn) => fn()); } };
}
test('the actual app Update button displays shared consent and authorizes one durable app-first handoff', async () => {
  const h = harness(); const tree = h.render(); assert.match(text(tree), /declared Python dependencies/); assert.match(text(tree), /Android/); assert.match(text(tree), /idle/);
  await button(tree, 'Update to 0.10.8')(); assert.deepEqual(h.events, ['authenticate', 'installer opened']); assert.equal(h.requests.length, 0);
  assert.equal(h.flow.useUnifiedUpdate.getState().record.version, update.version);
});
test('a new matching app process resumes the original signed owner job without another prompt', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version); next.api.api = async () => ({ version: '0.10.7', jobs: [] });
  await next.flow.unifiedUpdate.observe(); assert.equal(next.requests.length, 1); assert.equal(next.prompts.length, 0);
  assert.equal(next.requests[0][3].version, update.version); assert.equal(next.requests[0][3].idempotency_key, 'handoff-key');
});
test('saved handoff suppresses the app offer; installer waiting has explicit cancel and never claims installation success', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const view = harness(h.disk); await view.flow.unifiedUpdate.hydrate();
  assert.equal(view.prompt(), null); const progress = harness(h.disk); await progress.flow.unifiedUpdate.hydrate();
  const tree = progress.progress(); assert.equal(nodes(tree).find((n) => n.type === 'Sheet').props.dismissible, false);
  assert.match(text(tree), /server has not been changed/i); assert.doesNotMatch(text(tree), /app.*installed successfully/i);
  await button(tree, 'Cancel update')(); assert.equal(progress.flow.useUnifiedUpdate.getState().record, null);
});
test('a relaunched app recovers the saved job ID directly when its in-memory ledger is empty', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const first = harness(h.disk, update.version);
  first.api.api = async () => ({ version: '0.10.7', jobs: [] }); await first.flow.unifiedUpdate.observe();
  const next = harness(h.disk, update.version); const paths: string[] = [];
  const job = { id: 'job', kind: 'winglet_update', device_id: 'd', created_at: 1, updated_at: 2, state: 'succeeded', detail: { message: 'Server is back' } };
  next.api.api = async (_server: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/') ? { job } : { version: update.version, jobs: [] }; };
  await next.flow.unifiedUpdate.observe(); assert.ok(paths.includes('/api/jobs/job'));
  assert.equal(next.jobs.updateRecovery.snapshot(server).jobs[0]?.state, 'succeeded');
  const tree = next.progress(); assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'complete');
  await button(tree, 'Done')(); assert.equal(next.flow.useUnifiedUpdate.getState().record, null);
});
test('one managed job sheet owns unified progress, excluding the ordinary global plugin host', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const next = harness(h.disk, update.version);
  next.api.api = async () => ({ version: '0.10.7', jobs: [] }); await next.flow.unifiedUpdate.observe();
  const tree = next.progress(); assert.equal(nodes(tree).filter((n) => n.type === 'JobSheet').length, 1);
  const ordinary = load('components/UpdateJobHost.tsx', next.modules); const view = hooks(); assert.equal(view.render(() => ordinary.UpdateJobHost()), null);
});
test('a tracking job is refreshed while it is running and settles at its terminal result', async () => {
  let state = 'running'; const paths: string[] = [];
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const next = harness(h.disk, update.version);
  next.api.api = async (_s: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/')
    ? { job: { id: 'job', kind: 'winglet_update', device_id: 'd', state, detail: {}, updated_at: 2, created_at: 1 } }
    : { version: '0.10.7', jobs: [] }; };
  await next.flow.unifiedUpdate.observe(); assert.equal(next.flow.useUnifiedUpdate.getState().record.jobId, 'job');
  const tree = next.progress(); assert.ok(nodes(tree).find((n) => n.type === 'JobSheet'));
  const timers = new MockTimers(); try { state = 'succeeded'; paths.length = 0; await timers.tick(2000); } finally { timers.restore(); }
  assert.ok(paths.some((p) => p.startsWith('/api/jobs/')), `paths: ${paths.join(',')}`);
  assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'complete');
});
test('a tracking job refreshes even when its saved pairing is no longer selected', async () => {
  let state = 'running'; const paths: string[] = [];
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const next = harness(h.disk, update.version);
  next.api.api = async (_s: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/')
    ? { job: { id: 'job', kind: 'winglet_update', device_id: 'd', state, detail: {}, updated_at: 2, created_at: 1 } }
    : { version: '0.10.7', jobs: [] }; };
  await next.flow.unifiedUpdate.observe(); assert.equal(next.flow.useUnifiedUpdate.getState().record.jobId, 'job');
  next.change({ servers: [{ ...server, id: 'moved', deviceId: 'moved-device' }, server], selection: { serverId: 'moved' }, runtime: { moved: { status: 'online', me: { role: 'owner' } }, s: { status: 'online', me: { role: 'owner' } } } });
  next.api.api = async (_s: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/')
    ? { job: { id: 'job', kind: 'winglet_update', device_id: 'd', state, detail: {}, updated_at: 2, created_at: 1 } }
    : { version: '0.10.7', jobs: [] }; };
  await next.flow.unifiedUpdate.observe();
  state = 'succeeded'; paths.length = 0; await next.flow.unifiedUpdate.observe();
  assert.ok(paths.some((p) => p.startsWith('/api/jobs/')), `paths: ${paths.join(',')}`);
  assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'complete');
});
test('a stale error notice can be dismissed instead of blocking the app', async () => {
  const h = harness(); h.flow.useUnifiedUpdate.setState({ loaded: true, record: null, notice: 'stale read' });
  const tree = h.progress(); const sheet = nodes(tree).find((n) => n.type === 'Sheet'); assert.equal(sheet.props.dismissible, true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.flow.unifiedUpdate.clearError();
  assert.equal(h.flow.unifiedUpdate.error, '');
  assert.equal(h.progress(), null);
});
test('the handoff host waits for saved state instead of flashing an error before hydration', async () => {
  const h = harness(); h.flow.useUnifiedUpdate.setState({ loaded: false, record: null, error: 'stale read' });
  assert.equal(h.progress(), null);
});
test('a different installed app clears a saved consent for an unselected pairing once the host runs', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const next = harness(h.disk, '0.10.9');
  next.change({ servers: [{ ...server, id: 'moved', deviceId: 'moved-device' }], selection: { serverId: 'moved' }, runtime: { moved: { status: 'online', me: { role: 'owner' } } } });
  next.api.api = async () => ({ version: '0.10.7', jobs: [] }); await next.flow.unifiedUpdate.observe();
  next.progress(); await next.flow.unifiedUpdate.recoverOrphan();
  assert.equal(next.flow.useUnifiedUpdate.getState().record, null);
  assert.equal(next.prompt(), null);
});
test('a successful managed job never calls the handoff done/cancel action while it still owns the sheet', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')(); const next = harness(h.disk, update.version);
  next.api.api = async () => ({ version: '0.10.7', jobs: [] }); await next.flow.unifiedUpdate.observe();
  const sheet = nodes(next.progress()).find((node) => node.type === 'JobSheet'); assert.ok(sheet);
  let called = false; sheet.props.onClose = () => { called = true; }; sheet.props.job.state = 'succeeded';
  assert.equal(called, false);
});
test('an unreadable saved update can be cleared instead of blocking the app', async () => {
  const h = harness(); h.disk.set('winglet.unifiedUpdate.v1', { version: '0.10.8', key: '', stage: 'awaiting-app', message: 'corrupt' });
  await assert.rejects(h.flow.unifiedUpdate.hydrate(), /cannot be read/);
  assert.match(h.flow.useUnifiedUpdate.getState().notice, /cannot be read/i);
  const tree = h.progress(); assert.equal(nodes(tree).find((n) => n.type === 'Sheet').props.title, 'Update unavailable');
  await button(tree, 'Clear saved update')();
  assert.equal(h.flow.useUnifiedUpdate.getState().record, null);
  assert.equal(h.flow.useUnifiedUpdate.getState().notice, '');
});
test('an interrupted send is recovered from history by the exact release version', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version); const paths: string[] = [];
  next.api.api = async (_s: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/')
    ? { job: undefined }
    : { version: '0.10.7', jobs: [{ id: 'job', kind: 'winglet_update', device_id: 'd', created_at: Math.ceil(Date.now() / 1000), updated_at: 2, state: 'succeeded', detail: { to: '0.10.8' } }] }; };
  next.disk.set('winglet.unifiedUpdate.v1', { ...next.disk.get('winglet.unifiedUpdate.v1'), stage: 'dispatching' });
  await next.flow.unifiedUpdate.observe();
  assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'complete');
  assert.equal(next.flow.useUnifiedUpdate.getState().record.jobId, 'job');
  assert.ok(paths.includes('/api/system'));
});
test('an old job to the same release is not adopted as the result of a lost send', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version); const paths: string[] = [];
  next.api.api = async (_s: any, path: string) => { paths.push(path); return path.startsWith('/api/jobs/')
    ? { job: undefined }
    : { version: '0.10.7', jobs: [{ id: 'old', kind: 'winglet_update', device_id: 'd', created_at: 1, updated_at: 2, state: 'failed', detail: { to: '0.10.8' } }] }; };
  next.disk.set('winglet.unifiedUpdate.v1', { ...next.disk.get('winglet.unifiedUpdate.v1'), stage: 'dispatching' });
  await next.flow.unifiedUpdate.observe();
  assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'unknown');
  assert.equal(next.flow.useUnifiedUpdate.getState().record.jobId, undefined);
});
test('an orphan dispatching or tracking notice can be cleared without the saved pairing', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version); next.api.api = async () => ({ version: '0.10.7', jobs: [] });
  await next.flow.unifiedUpdate.observe();
  next.change({ servers: [{ ...server, id: 'moved', deviceId: 'moved-device' }, server], selection: { serverId: 'moved' }, runtime: { moved: { status: 'online', me: { role: 'owner' } }, s: { status: 'online', me: { role: 'owner' } } } });
  const tree = next.progress(); assert.match(text(tree), /no longer selected/i);
  await button(tree, 'Clear saved update')();
  assert.equal(next.flow.useUnifiedUpdate.getState().record, null);
});
test('a non-owner can close a terminal server notice without acknowledging it', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version);
  next.change({ runtime: { s: { status: 'online', me: { role: 'member' } } } });
  next.disk.set('winglet.unifiedUpdate.v1', { ...next.disk.get('winglet.unifiedUpdate.v1'), stage: 'complete', message: 'App and server are on 0.10.8.' });
  await next.flow.unifiedUpdate.hydrate();
  const tree = next.progress(); const done = nodes(tree).find((n) => n.props?.title === 'Done');
  assert.equal(done.props.disabled, undefined);
  await button(tree, 'Done')();
  assert.equal(next.flow.useUnifiedUpdate.getState().record, null);
});
test('a saved consent older than seven days is closed without sending a server command', async () => {
  const h = harness(); await button(h.render(), 'Update to 0.10.8')();
  const next = harness(h.disk, update.version);
  next.disk.set('winglet.unifiedUpdate.v1', { ...next.disk.get('winglet.unifiedUpdate.v1'), created: Date.now() - 8 * 24 * 60 * 60 * 1000 });
  await next.flow.unifiedUpdate.observe();
  assert.equal(next.flow.useUnifiedUpdate.getState().record.stage, 'complete');
  assert.equal(next.flow.useUnifiedUpdate.getState().record.message, 'The saved update consent expired. No server command was sent.');
  assert.equal(next.requests.length, 0);
});
