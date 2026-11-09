import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, hooks, jsx, anything, nodes, text, button, tick, server, updates } from './helpers/serverUpdateHarness.ts';

const appUpdate = { version: '0.10.8', apk: 'https://example.invalid/update.apk', page: 'https://example.invalid/release', notes: 'Bug fixes' };

function appUpdateCardHarness(opts: { appBehind?: boolean; pluginBehind?: boolean; role?: string; online?: boolean; appVersion?: string }) {
  const host = hooks();
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: opts.online !== false ? 'online' : 'offline', me: { role: opts.role ?? 'owner' } } } };
  const useApp: any = (select: any) => select(state); useApp.getState = () => state; useApp.subscribe = () => () => {};
  let checked = false, serverChecked = false;
  const updatesState = opts.pluginBehind ? updates : null;
  const installButton = ({ update }: any) => ({ type: 'InstallButton', props: { update } });
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Text: 'Text', View: 'View', Linking: { openURL: () => {} } },
    'expo-constants': { expoConfig: { version: opts.appVersion ?? '0.10.7' } }, 'expo-router': { router: { push: () => {} } },
    '../components/AppUpdate': { InstallButton: installButton },
    '../components/AgentFace': () => null, '../components/icons': anything, '../components/Logo': () => null, '../components/Screen': ({ children }: any) => children,
    '../components/ui': { Button: 'Button', Card: 'Card', Footnote: () => null, ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader', Toggle: 'Toggle' },
    '../lib/agent': { agoText: () => 'just now' },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: () => ({ update: opts.appBehind ? appUpdate : null, checking: false, checkedAt: null, failed: false, check: async () => { checked = true; } }) },
    '../lib/cache': { checkCacheStatus: async () => {}, getCacheStatus: () => 'available', subscribeCacheStatus: () => () => {} },
    '../lib/prefs': { usePrefs: (fn: any) => fn({ prefs: { updateCheck: true }, update: () => {} }) },
    '../lib/store': { APP_PROTOCOL: 1, useApp },
    '../lib/serverUpdates': {
      serverUpdateKey: () => 's',
      checkServerUpdates: async () => { serverChecked = true; },
      updateServerWinglet: async () => {},
      useServerUpdates: (select: any) => select({ byServer: { s: updatesState } }),
    },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
    '../lib/version': { compareVersions: () => 0 },
  };
  const { AppUpdateCard } = load('app/about.tsx', modules);
  return { host, installButton, render: () => host.render(() => AppUpdateCard({ appVersion: opts.appVersion ?? '0.10.7' })), checked: () => checked, serverChecked: () => serverChecked };
}

function installButtonHarness(pluginData: any = null, role = 'owner') {
  const host = hooks();
  const state: any = { servers: [server], selection: { serverId: 's' }, runtime: { s: { status: 'online', me: { role } } } };
  const useApp: any = (select: any) => select(state); useApp.getState = () => state; useApp.subscribe = () => () => {};
  let unifiedStarted = false, serverTarget: string | undefined;
  const modules: any = {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Text: 'Text', View: 'View', Linking: {} },
    'expo-constants': { expoConfig: { version: '0.10.7' } },
    '../lib/unifiedUpdateFlow': {
      useUnifiedUpdate: (select: any) => select({ loaded: true, record: null, working: false, error: null }),
      unifiedUpdate: { start: async () => { unifiedStarted = true; } },
      updateContext: () => ({ server, role }),
    },
    '../lib/appInstall': { useAppInstall: () => ({ phase: 'ready' }) },
    '../lib/appUpdateCheck': { appUpdateSupported: true, useAppUpdate: () => ({ update: null }) },
    '../lib/appLock': { useLock: (select: any) => select({ locked: false }) },
    '../lib/prefs': { usePrefs: (fn: any) => fn({ prefs: { updateCheck: true } }) },
    '../lib/storage': { getJSON: async () => null },
    '../lib/store': { useApp, useServerState: () => state.runtime.s },
    '../lib/updateJobs': { updateScope: () => 's' },
    '../lib/serverUpdates': {
      serverUpdateKey: () => 's',
      checkServerUpdates: async () => {},
      updateServerWinglet: async (_server: any, version: string) => { serverTarget = version; },
      useServerUpdates: (select: any) => select({ byServer: { s: pluginData } }),
    },
    '../lib/themeContext': { makeStyles: () => () => anything, useTheme: () => anything },
    './icons': {},
    './Sheet': { Sheet: 'Sheet' },
    './ui': { Button: 'Button' },
    './JobSheet': { JobSheet: 'JobSheet' },
  };
  const app = load('components/AppUpdate.tsx', modules);
  return { host, app, render: (update: any = null) => host.render(() => app.InstallButton({ update })), unifiedStarted: () => unifiedStarted, serverTarget: () => serverTarget };
}

test('AppUpdateCard shows plugin-only offer when app current and plugin behind', async () => {
  const h = appUpdateCardHarness({ pluginBehind: true });
  const tree = h.render();
  await tick();
  assert.equal(h.checked(), true);
  assert.equal(h.serverChecked(), true);
  assert.match(text(tree), /Server plugin 0\.10\.6 available/);
  assert.ok(nodes(tree).some((n) => n.type === h.installButton && n.props?.update === null));
});

test('AppUpdateCard shows unified offer when app behind', async () => {
  const h = appUpdateCardHarness({ appBehind: true });
  const tree = h.render();
  await tick();
  assert.match(text(tree), /Winglet 0\.10\.8 available/);
  assert.ok(nodes(tree).some((n) => n.type === h.installButton && n.props?.update && n.props.update.version === '0.10.8'));
});

test('AppUpdateCard skips server check when offline', async () => {
  const h = appUpdateCardHarness({ pluginBehind: true, online: false });
  h.render();
  await tick();
  assert.equal(h.serverChecked(), false);
});

test('AppUpdateCard checks server updates when plugin behind and online', async () => {
  const h = appUpdateCardHarness({ pluginBehind: true });
  h.render();
  await tick();
  assert.equal(h.serverChecked(), true);
});

test('InstallButton plugin-only calls updateServerWinglet when pressed', async () => {
  const h = installButtonHarness(updates);
  const tree = h.render(null);
  const b = nodes(tree).find((n) => n.props?.title?.startsWith('Update plugin'));
  assert.ok(b);
  assert.equal(b.props.title, 'Update plugin to 0.10.6');
  await b.props.onPress();
  assert.equal(h.serverTarget(), '0.10.6');
  assert.equal(h.unifiedStarted(), false);
});

test('InstallButton app behind calls unifiedUpdate.start when pressed', async () => {
  const h = installButtonHarness(null);
  const tree = h.render(appUpdate);
  const b = nodes(tree).find((n) => n.props?.title?.startsWith('Update to'));
  assert.ok(b);
  assert.equal(b.props.title, 'Update to 0.10.8');
  await b.props.onPress();
  assert.equal(h.unifiedStarted(), true);
  assert.equal(h.serverTarget(), undefined);
});

test('InstallButton plugin-only disables update for non-owner', async () => {
  const h = installButtonHarness(updates, 'member');
  const tree = h.render(null);
  const b = nodes(tree).find((n) => n.props?.title?.startsWith('Update plugin'));
  assert.ok(b);
  assert.equal(b.props.disabled, true);
});
