import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { load, hooks, jsx, anything, network, server, tick, nodes } from './helpers/serverUpdateHarness.ts';

test('one global plugin job host replaces competing prompt/local sheets; Server has a persistent plugin result row', () => {
  const root = readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  const prompt = readFileSync(new URL('../src/components/ServerUpdatePrompt.tsx', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../src/app/server.tsx', import.meta.url), 'utf8');
  assert.match(root, /<UpdateJobHost\s*\/>/);
  assert.doesNotMatch(prompt, /<JobSheet/);
  assert.match(screen, /Server plugin update/);
  assert.match(screen, /job\?\.kind !== 'winglet_update'/);
});
function harness() {
  const net = network(), host = hooks(); let role: any = 'owner', selected: any = server, interval: any;
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: 'owner' } } } };
  const useApp: any = (fn: any) => fn(state); useApp.getState = () => state;
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../lib/updateJobs': net.jobs, '../lib/store': { useApp, useServerState: () => ({ status: 'online', me: { role } }) },
    './JobSheet': { JobSheet: 'JobSheet' }, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button', Footnote: 'Footnote' },
    'react-native': { Text: 'Text', View: 'View' }, '../lib/themeContext': { makeStyles: () => () => anything },
    'expo-router': { usePathname: () => '/' },
  };
  const exports = load('components/UpdateJobHost.tsx', modules, { setInterval: (fn: any) => { interval = fn; return 1; }, clearInterval: () => {} });
  return { ...net, render: () => host.render(() => exports.UpdateJobHost()), inner: () => host.render(() => exports.PairingUpdateJobs({ server: selected })),
    role: (r: any) => { role = r; state.runtime.s.me.role = r; }, switch: (s: any) => { selected = s; state.servers = [s]; }, poll: () => interval?.(), unmount: host.unmount };
}
test('host requires explicit owner and scopes visible results across device switching', async () => {
  const h = harness(); assert.ok(h.render()); h.role(undefined); assert.equal(h.render(), null); h.role('member'); assert.equal(h.render(), null);
  h.role('owner'); await h.jobs.updateRecovery.track(server, { id: 'j', kind: 'winglet_update', device_id: 'd', state: 'running', updated_at: 1, created_at: 1, detail: {} });
  assert.equal(nodes(h.inner()).find((n) => n.type === 'JobSheet')?.props.job.id, 'j');
  h.switch({ ...server, deviceId: 'other' }); assert.ok(!nodes(h.inner()).some((n) => n.type === 'JobSheet'));
});
test('a reconnect poll updates the globally visible running sheet to the terminal result', async () => {
  const h = harness(); const running = { id: 'j', kind: 'winglet_update', device_id: 'd', state: 'running', updated_at: 1, created_at: 1, detail: {} };
  await h.jobs.updateRecovery.track(server, running); h.inner();
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(h.checks.includes('/api/jobs/j'), 'initial recovery reached the existing job endpoint');
  h.api.api = async () => ({ jobs: [{ ...running, state: 'failed', updated_at: 2, detail: { message: 'Rolled back safely' } }] }) as any;
  await h.poll(); await tick();
  assert.equal(nodes(h.inner()).find((n) => n.type === 'JobSheet')?.props.job.state, 'failed');
});
test('host keeps terminal result until explicit Done then acknowledges durably', async () => {
  const h = harness(); await h.jobs.updateRecovery.track(server, { id: 'j', kind: 'winglet_update', device_id: 'd', state: 'failed', updated_at: 2, created_at: 1, detail: {} });
  const tree = h.inner(); const sheet = nodes(tree).find((n) => n.type === 'JobSheet'); assert.ok(sheet);
  assert.equal(sheet.props.managed, true); h.unmount(); assert.equal(h.jobs.updateRecovery.snapshot(server).jobs.length, 1);
  await sheet.props.onClose(); await tick(); assert.equal(h.jobs.updateRecovery.snapshot(server).jobs.length, 0);
});
