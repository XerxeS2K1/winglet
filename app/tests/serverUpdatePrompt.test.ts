import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, hooks, jsx, anything, nodes, text, button, tick, server, updates, network } from './helpers/serverUpdateHarness.ts';

function harness(options: any = {}) {
  const net = network(); let state: any = { servers: [server], selection: { serverId: server.id }, runtime: { s: { status: 'online', me: { role: options.role ?? 'owner' } } } };
  const storage = options.storage ?? new Map(); let host = hooks(); let locked = false;
  const useApp: any = (select: any) => select(state); useApp.getState = () => ({ ...state, toast: (value: any) => toasts.push(value) });
  const toasts: any[] = [];
  const data = { ...updates, winglet: { ...updates.winglet, ...options.winglet } }; net.setUpdates(data); net.core.useServerUpdates.getState().publish(server, data);
  const modules: any = {
    react: new Proxy({}, { get: (_t, name) => (host.react as any)[name] }), 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View' },
    '../lib/serverUpdates': net.core, '../lib/updateJobs': net.jobs, '../lib/api': net.api,
    '../lib/store': { useApp, useServerState: () => state.runtime.s },
    '../lib/appLock': { useLock: (select: any) => select({ locked }) },
    '../lib/storage': { getJSON: async (key: string, fallback: any) => storage.get(key) ?? fallback, setJSON: async (key: string, value: any) => { storage.set(key, value); } },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
    'expo-router': { usePathname: () => '/' },
    './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button' }, './JobSheet': { JobSheet: 'JobSheet' },
  };
  const exports = load('components/ServerUpdatePrompt.tsx', modules);
  const render = () => host.render(() => exports.ServerPrompt({ server }));
  return { ...net, storage, toasts, render, root: () => host.render(() => exports.ServerUpdatePrompt()), unmount: () => host.unmount(),
    remount: () => { host.unmount(); host = hooks(); }, pairing: (value: any) => { state.servers = [value]; }, role: (role: any) => { state.runtime.s.me.role = role; }, lock: () => { locked = true; },
    publish: (winglet: any) => net.core.useServerUpdates.getState().publish(server, { ...data, winglet: { ...data.winglet, ...winglet } }),
  };
}
const offer = (tree: any) => nodes(tree).find((n) => n.type === 'Sheet' && n.props.title === 'Update the server?');
async function ready(h: any) { h.render(); await tick(); return h.render(); }

test('startup prompt mounts only for a confirmed owner, not members or unknown roles', () => {
  const h = harness(); assert.ok(h.root()); h.role('member'); assert.equal(h.root(), null); h.role(undefined); assert.equal(h.root(), null);
});
for (const winglet of [{ update_available: false }, { update_available: null }, { update_available: undefined }, { latest_release: null }]) test(`prompt requires a real available release: ${JSON.stringify(winglet)}`, async () => {
  const h = harness({ winglet }); assert.ok(!offer(await ready(h))?.props.visible);
});
test('startup fetches update metadata and displays versions, clamped notes and restart/backup copy', async () => {
  const h = harness(), tree = await ready(h); assert.ok(h.checks.includes('/api/system/updates'));
  assert.equal(offer(tree).props.visible, true); assert.match(text(tree), /0\.10\.5.*→.*0\.10\.6/);
  assert.match(text(tree), /authorizes.*pinned.*release.*declared Python dependencies/i);
  assert.match(text(tree), /installs first.*restarts when chats are idle/i);
  assert.doesNotMatch(text(tree), /30 seconds/i);
  assert.match(text(tree), /backup.*rollback/i);
  assert.equal(nodes(tree).find((n) => n.props.children === 'Release details')?.props.numberOfLines, 6);
});
test('Later survives remounts in this run but reoffers on the next app run', async () => {
  const h = harness(); button(await ready(h), 'Later')(); assert.equal(offer(h.render()).props.visible, false);
  h.remount(); assert.equal(offer(await ready(h)).props.visible, false);
  const next = harness({ storage: h.storage }); assert.equal(offer(await ready(next)).props.visible, true);
});
test('Skip this version persists across runs but does not hide a later version', async () => {
  const h = harness(); await button(await ready(h), 'Skip this version')(); await tick();
  const next = harness({ storage: h.storage }); assert.equal(offer(await ready(next)).props.visible, false);
  next.publish({ latest_release: { ...updates.winglet.latest_release, version: '0.10.7' } });
  assert.equal(offer(next.render()).props.visible, true);
});
test('busy names/states and unknown state warn without disabling Update server', async () => {
  const h = harness({ winglet: { busy: { bots: [{ bot: 'coder', state: 'working', queued: 2 }], unknown: true } } }); const tree = await ready(h);
  assert.match(text(tree), /coder.*working/); assert.match(text(tree), /couldn't tell/i); assert.ok(button(tree, 'Update server'));
  const b = nodes(tree).find((n) => n.props.title === 'Update server'); assert.ok(!b.props.disabled);
});
test('incompatible Hermes explains the requirement and offers no update action', async () => {
  const h = harness({ winglet: { requires_hermes_ok: false } }), tree = await ready(h);
  assert.match(text(tree), /Hermes.*too old/i); assert.ok(!nodes(tree).some((n) => n.props.title === 'Update server'));
});
test('prompt action uses real awaited authentication, preserves version and opens the existing JobSheet', async () => {
  const h = harness(), tree = await ready(h); const pending = button(tree, 'Update server')(); await tick();
  assert.equal(h.requests.length, 0); assert.deepEqual(h.prompts, ['Update the server']); h.resolve(true); await pending;
  assert.equal(h.requests[0][3].version, '0.10.6'); assert.equal(h.requests[0][3].idempotency_key, 'key');
  assert.equal(h.jobs.updateRecovery.snapshot(server).jobs[0]?.id, 'job');
  assert.ok(!nodes(h.render()).some((n) => n.type === 'JobSheet'));
});
test('prompt authentication cancellation and a role change while authenticating send nothing', async () => {
  const h = harness(); let pending = button(await ready(h), 'Update server')(); h.resolve(false); await pending; assert.equal(h.requests.length, 0);
  pending = button(h.render(), 'Update server')(); h.role('member'); h.resolve(true); await pending; assert.equal(h.requests.length, 0);
});
test('changing the paired server address during unlock cancels the old request', async () => {
  const h = harness(), pending = button(await ready(h), 'Update server')(); h.pairing({ ...server, url: 'https://moved.invalid' }); h.resolve(true); await pending;
  assert.equal(h.requests.length, 0);
});
for (const status of [400, 409, 503]) test(`prompt surfaces ${status} server error text`, async () => {
  const h = harness(); h.fail(status, `Server says ${status}`); const pending = button(await ready(h), 'Update server')(); h.resolve(true); await pending;
  assert.ok(text(h.render()).includes(`Server says ${status}`));
});
