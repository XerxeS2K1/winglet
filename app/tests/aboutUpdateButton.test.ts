import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anything, button, hooks, jsx, load, nodes, server, text, tick } from './helpers/serverUpdateHarness.ts';

const appUpdate = { version: '0.10.8', apk: 'https://example.invalid/update.apk', page: 'https://example.invalid/release', notes: 'Bug fixes' };
const compare = (a: string, b: string) => {
  const p = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
};

function aboutHarness(opts: { role?: string; app?: any; system?: any; settings?: any } = {}) {
  const host = hooks();
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: opts.role ?? 'owner' } } } };
  const useApp: any = (select: any) => select(state); useApp.getState = () => state; useApp.subscribe = () => () => {};
  const gets: string[] = [], puts: any[] = [];
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View', Linking: { openURL: () => {} } },
    'expo-constants': { expoConfig: { version: '0.10.7' } }, 'expo-router': { router: { push: () => {} } },
    '../components/AppUpdate': { InstallButton: ({ update }: any) => ({ type: 'InstallButton', props: { update } }) },
    '../components/AgentFace': () => null, '../components/icons': anything, '../components/Logo': () => null,
    '../components/Screen': ({ children }: any) => children,
    '../components/ui': { Button: 'Button', Card: 'Card', Footnote: () => null, ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader', Toggle: 'Toggle' },
    '../lib/agent': { agoText: () => 'just now' },
    '../lib/api': {
      api: async (_s: any, path: string) => { gets.push(path); return path === '/api/system' ? (opts.system ?? { version: '0.11.0', updatedAt: 1710000000, hermes_version: '0.23.0' }) : (opts.settings ?? { autoUpdate: true }); },
      signedApi: async (...args: any[]) => { puts.push(args); return { autoUpdate: args[3].autoUpdate }; },
    },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: Object.assign(() => ({ update: opts.app ?? null, checking: false, checkedAt: null, failed: false, check: async () => {} }), { getState: () => ({ forget: () => {} }) }) },
    '../lib/cache': { checkCacheStatus: async () => {}, getCacheStatus: () => 'available', subscribeCacheStatus: () => () => {} },
    '../lib/prefs': { usePrefs: (fn: any) => fn({ prefs: { updateCheck: true }, update: () => {} }) },
    '../lib/store': { APP_PROTOCOL: 1, useApp },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
    '../lib/version': { compareVersions: compare },
  };
  const about = load('app/about.tsx', modules);
  return { host, about, gets, puts };
}

test('About offers the Android app only, with no server plugin offer', async () => {
  const h = aboutHarness({ app: appUpdate });
  const tree = h.about.AppUpdateCard({ appVersion: '0.10.7' });
  await tick();
  assert.match(text(tree), /Winglet 0\.10\.8 available/);
  assert.ok(nodes(tree).some((n) => n.props?.update?.version === '0.10.8'));
});

test('About says Check now when no app update is published', async () => {
  const tree = aboutHarness().about.AppUpdateCard({ appVersion: '0.10.7' });
  assert.ok(nodes(tree).some((n) => n.props?.title === 'Check now'));
});

function autoUpdateHarness(opts: { role?: string; settings?: any } = {}) {
  const host = hooks();
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role: opts.role ?? 'owner' } } } };
  const useApp: any = (select: any) => select(state); useApp.getState = () => state; useApp.subscribe = () => () => {};
  const gets: string[] = [], puts: any[] = [];
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text' },
    './icons': anything,
    './ui': { Footnote: () => null, ListGroup: 'ListGroup', ListRow: 'ListRow', Toggle: 'Toggle' },
    '../lib/api': {
      api: async (_s: any, path: string) => { gets.push(path); return opts.settings ?? { autoUpdate: true }; },
      signedApi: async (...args: any[]) => { puts.push(args); return { autoUpdate: args[3].autoUpdate }; },
    },
    '../lib/store': { useApp },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
  };
  const card = load('components/ServerAutoUpdate.tsx', modules);
  return { host, card, gets, puts };
}

test('a member never sees the server auto-update toggle', () => {
  const h = autoUpdateHarness({ role: 'member' });
  assert.equal(h.host.render(() => h.card.ServerAutoUpdateCard()), null);
  assert.equal(h.gets.length, 0);
});

test('an owner sees autoUpdate and writes only autoUpdate through the signed settings endpoint', async () => {
  const h = autoUpdateHarness({ role: 'owner' });
  h.host.render(() => h.card.ServerAutoUpdateCard());
  await tick();
  const tree = h.host.render(() => h.card.ServerAutoUpdateCard());
  assert.ok(nodes(tree).some((n) => n.props?.title === 'Update automatically'));
  assert.ok(nodes(tree).some((n) => n.props?.value === 'On'));
  const toggle = nodes(tree).find((n) => n.type === 'Toggle');
  assert.ok(toggle);
  await toggle.props.onValueChange(false);
  await tick();
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0][1], 'PUT');
  assert.equal(h.puts[0][2], '/api/settings');
  assert.equal(h.puts[0][3].autoUpdate, false);
});

function installHarness(opts: { update?: any; error?: string; outcome?: string } = {}) {
  const host = hooks();
  let started: any = null, forgotten = false;
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View', Linking: { openURL: () => {} } },
    'expo-constants': { expoConfig: { version: '0.10.7' } },
    '../lib/appInstall': { useAppInstall: (select: any) => select({ phase: 'idle', progress: null, error: opts.error ?? '' }) },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: Object.assign(() => ({ update: null }), { getState: () => ({ forget: () => { forgotten = true; } }) }) },
    '../lib/version': { compareVersions: compare },
    '../lib/appLock': { useLock: (select: any) => select({ locked: false }) },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { updateCheck: true } }) },
    '../lib/unifiedUpdateFlow': {
      useUnifiedUpdate: (select: any) => select({ working: false, error: opts.error ?? '' }),
      appUpdateFlow: { start: async (update: any) => { started = update; return opts.outcome ?? 'opened'; } },
    },
    '../lib/storage': { getJSON: async () => null, setJSON: async () => {} },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
    './icons': anything, './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button' },
  };
  const app = load('components/AppUpdate.tsx', modules);
  return { host, app, started: () => started, forgotten: () => forgotten,
    render: (update: any) => host.render(() => app.InstallButton({ update })) };
}

test('InstallButton downloads and installs the app; it never contacts a server update endpoint', async () => {
  const h = installHarness();
  const tree = h.render(appUpdate);
  const press = button(tree, 'Update to 0.10.8');
  await press();
  await tick();
  assert.equal(h.started()?.version, '0.10.8');
  assert.equal(h.forgotten(), true);
});

test('InstallButton offers nothing when the build is already current or newer', () => {
  assert.equal(installHarness().render({ ...appUpdate, version: '0.10.7' }), null);
  assert.equal(installHarness().render({ ...appUpdate, version: '0.10.6' }), null);
});

test('InstallButton shows a download error and keeps the sheet open', () => {
  const h = installHarness({ error: "Couldn't download the update. Check your connection and try again." });
  const tree = h.render(appUpdate);
  assert.match(text(tree), /Couldn't download the update/);
  assert.ok(nodes(tree).some((n) => n.type === 'Button' && n.props.title === 'Update to 0.10.8'));
});

test('InstallButton does not forget the offer when Android cancels the installer', async () => {
  const h = installHarness({ outcome: 'cancelled' });
  await button(h.render(appUpdate), 'Update to 0.10.8')();
  await tick();
  assert.equal(h.forgotten(), false);
});
