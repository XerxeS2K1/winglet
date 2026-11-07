import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { load, hooks, jsx, anything, nodes, button, tick, server, updates, network } from './helpers/serverUpdateHarness.ts';
function harness(data: any = updates) {
  const net = network(), host = hooks(); net.setUpdates(data);
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: 'owner' } } } }, toasts: any[] = [];
  const useApp: any = (select: any) => select(state); useApp.getState = () => ({ ...state, toast: (v: any) => toasts.push(v) });
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Text: 'Text', View: 'View' },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, FadeIn: anything }, 'expo-router': { router: anything, useFocusEffect: () => {} },
    '../components/JobSheet': { JobSheet: 'JobSheet' }, '../components/icons': anything,
    '../components/Screen': { Screen: 'Screen' }, '../components/ServerScreen': { withSelectedServer: (c: any) => c }, '../components/Sheet': { Sheet: 'Sheet' },
    '../components/ui': { Button: 'Button', Card: 'Card', ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader', Skeleton: 'Skeleton', Toggle: 'Toggle' },
    '../components/VerifyPhone': { VerifyNotice: 'VerifyNotice' }, '../lib/agent': { agoText: () => '' }, '../lib/api': net.api,
    '../lib/control': { bytes: () => '', duration: () => '', idempotencyKey: () => 'key' }, '../lib/haptics': { haptic: { error: () => {}, success: () => {} } },
    '../lib/motion': { spring: {}, useReducedMotion: () => true }, '../lib/store': { useApp, useServerState: () => state.runtime.s, isOwner: (rt: any) => (rt?.me?.role ?? 'owner') === 'owner' },
    '../lib/themeContext': { useTheme: () => anything, makeStyles: () => () => anything }, '../lib/serverUpdates': net.core,
  };
  const exports = load('app/server.tsx', modules);
  const render = () => host.render(exports.default);
  const start = async () => { render(); await tick(); const row = nodes(render()).find((n) => n.props?.name === 'Winglet'); assert.ok(row); row.props.onUpdate();
    const confirm = nodes(render()).find((n) => n.props?.what === 'winglet'); assert.ok(confirm); return { run: confirm.props.onConfirm }; };
  return { ...net, render, start, toasts, unmount: host.unmount };
}
test('Server Winglet row awaits unlock then sends the release version and key', async () => {
  const h = harness(), action = await h.start(); const pending = action.run('winglet'); await tick();
  assert.equal(h.requests.length, 0); assert.deepEqual(h.prompts, ['Update the server']); h.resolve(true); await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0][3])), { target: 'winglet', version: '0.10.6', idempotency_key: 'key' });
});
test('Server Winglet row sends nothing after unlock cancellation', async () => {
  const h = harness(), action = await h.start(); const pending = action.run('winglet'); await tick(); assert.equal(h.requests.length, 0); h.resolve(false); await pending; assert.equal(h.requests.length, 0);
});
test('Server Winglet row falls back to legacy latest version but still authenticates', async () => {
  const h = harness({ ...updates, winglet: { ...updates.winglet, latest_release: undefined, latest: '0.10.7' } }); const action = await h.start(); const pending = action.run('winglet');
  assert.deepEqual(h.prompts, ['Update the server']); h.resolve(true); await pending; assert.equal(h.requests[0][3].version, '0.10.7');
});
test('very old server without a latest version retains its legacy payload behind authentication', async () => {
  const h = harness({ ...updates, winglet: { version: '0.10.3', update_available: true } }); const action = await h.start(); const pending = action.run('winglet');
  assert.deepEqual(h.prompts, ['Update the server']); h.resolve(true); await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0][3])), { target: 'winglet', idempotency_key: 'key' });
});
test('incompatible Hermes hides the Server row update button', async () => {
  const h = harness({ ...updates, winglet: { ...updates.winglet, requires_hermes_ok: false } }); h.render(); await tick();
  assert.equal(nodes(h.render()).find((n) => n.props?.name === 'Winglet')?.props.available, false);
});
test('Check now publishes its forced result to the startup prompt cache', async () => {
  const h = harness(); h.render(); await tick(); const fresh = { ...updates, winglet: { ...updates.winglet, latest_release: { ...updates.winglet.latest_release, version: '0.10.7' } } }; h.setUpdates(fresh);
  button(h.render(), 'Check now')(); await tick();
  assert.ok(h.checks.includes('/api/system/updates?force=1'));
  assert.equal(h.core.useServerUpdates.getState().byServer[h.core.serverUpdateKey(server)].winglet.latest_release.version, '0.10.7');
});
for (const status of [400, 409, 503]) test(`Server Winglet row surfaces ${status} text`, async () => {
  const h = harness(); h.fail(status, `Row server says ${status}`); const action = await h.start(); const pending = action.run('winglet');
  assert.deepEqual(h.prompts, ['Update the server']); h.resolve(true); await pending; assert.equal(h.toasts[0].body, `Row server says ${status}`);
});
test('startup mounts server prompt alongside unchanged APK prompt and About no longer requires manual paired-server updates', () => {
  const root = readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(root, /<ServerUpdatePrompt\s*\/>/); assert.match(root, /<UpdatePrompt\s*\/>/);
  const about = readFileSync(new URL('../src/app/about.tsx', import.meta.url), 'utf8');
  assert.match(about, /app can update the server/i); assert.match(about, /no phone paired/i);
});
