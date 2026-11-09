import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { load, hooks, jsx, anything, nodes, text, button, tick, server, updates, network } from './helpers/serverUpdateHarness.ts';
function harness(data: any = updates) {
  const net = network(), host = hooks(); net.setUpdates(data);
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: 'owner' } } } }, toasts: any[] = [];
  const useApp: any = (select: any) => select(state); useApp.getState = () => ({ ...state, toast: (v: any) => toasts.push(v) });
  const pushes: string[] = [];
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Text: 'Text', View: 'View' },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, FadeIn: anything }, 'expo-router': { router: { push: (p: string) => pushes.push(p), back: () => {} }, useFocusEffect: host.useFocusEffect, usePathname: () => '/' },
    '../components/JobSheet': { JobSheet: 'JobSheet' }, '../components/icons': anything,
    '../components/Screen': { Screen: 'Screen' }, '../components/ServerScreen': { withSelectedServer: (c: any) => c }, '../components/Sheet': { Sheet: 'Sheet' },
    '../components/ui': { Button: 'Button', Card: 'Card', ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader', Skeleton: 'Skeleton', Toggle: 'Toggle' },
    '../components/VerifyPhone': { VerifyNotice: 'VerifyPhone' }, '../lib/agent': { agoText: () => '' }, '../lib/api': net.api,
    '../lib/control': { bytes: () => '', duration: () => '', idempotencyKey: () => 'key' }, '../lib/haptics': { haptic: { error: () => {}, success: () => {} } },
    '../lib/motion': { spring: {}, useReducedMotion: () => true }, '../lib/store': { useApp, useServerState: () => state.runtime.s, isOwner: (rt: any) => rt?.me?.role === 'owner' },
    '../lib/themeContext': { useTheme: () => anything, makeStyles: () => () => anything }, '../lib/serverUpdates': net.core, '../lib/updateJobs': net.jobs,
  };
  const exports = load('app/server.tsx', modules, { setInterval: () => 0, clearInterval: () => {} });
  const render = () => host.render(exports.default);
  const wingletRow = () => { render(); const row = nodes(render()).find((n) => n.props?.name === 'Winglet'); assert.ok(row); return row; };
  return { ...net, render, wingletRow, toasts, pushes, pairing: (next: any) => { state.servers = [next]; state.selection.serverId = next.id; },
    role: (role?: string) => { state.runtime = { [state.selection.serverId ?? server.id]: { status: 'online', me: { role } } }; },
    focus: host.focus, blur: host.blur, unmount: host.unmount };
}

test('Server screen ignores old history arriving after the paired server changes', async () => {
  const h = harness(); let answer: any; const original = h.api.api;
  h.api.api = ((_s: any, path: string) => path === '/api/system' ? new Promise((resolve) => { answer = resolve; }) : original(_s, path)) as any;
  h.render(); h.focus(); assert.ok(answer);
  h.pairing({ ...server, deviceId: 'new', url: 'https://new.invalid' }); h.render();
  answer({ version: 'old', jobs: [{ id: 'old', kind: 'winglet_update', state: 'failed', detail: { message: 'Old pairing result' } }] }); await tick();
  assert.ok(!nodes(h.render()).some((n) => n.props?.subtitle === 'Old pairing result'));
});

test('Server Winglet row sends the owner to About instead of starting a plugin job', async () => {
  const h = harness(); h.wingletRow().props.onUpdate(); await tick();
  assert.deepEqual(h.pushes, ['/about']);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('Server Winglet row is hidden for non-owners', async () => {
  const h = harness(); h.render(); await tick();
  h.role('member');
  const row = nodes(h.render()).find((n) => n.props?.name === 'Winglet');
  assert.equal(row?.props.available, false);
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

test('startup uses one app update offer and unified handoff host, retaining standalone Server repair', () => {
  const root = readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(root, /<ServerUpdatePrompt\s*\/>/); assert.match(root, /<UnifiedUpdateHost\s*\/>/); assert.match(root, /<UpdatePrompt\s*\/>/);
  const about = readFileSync(new URL('../src/app/about.tsx', import.meta.url), 'utf8');
  assert.match(about, /Winglet is behind/i); assert.doesNotMatch(about, /app can update the server/i);
});
