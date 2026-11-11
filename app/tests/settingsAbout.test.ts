import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Settings is this phone and the app; About is the app's own version, updates, storage and help. These read the
// source because the screens need React Native to run.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const at = (text: string, marker: string) => {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  return i;
};

test('Settings has the decided order: bot card, preferences, on this phone, app', () => {
  const settings = source('app/settings.tsx');
  const order = ['onPress={() => router.push(\'/agent\')}', '<SectionHeader title="Preferences" />', 'title="Appearance"', 'title="Notifications"',
    'title="App lock"', '<Text style={s.label}>Sidebar</Text>', '<SectionHeader title="On this phone" />', 'title="Phone tools"',
    'title="Android assistant"', 'title="Wear OS"', '<SectionHeader title="App" />', 'title="Open the app on"', 'title="About"'].map((m) => at(settings, m));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('Settings has one Notifications entry, no separate About & storage row, and nothing about a server or a bot\'s versions', () => {
  const settings = source('app/settings.tsx');
  assert.equal((settings.match(/title="Notifications"/g) ?? []).length, 1);
  assert.doesNotMatch(settings, /About & storage|Server updates|hermes_version|Your bots|Add a bot/);
  at(settings, "router.push('/about')");
  assert.match(settings, /value=\{appUpdate \? `Update to \$\{appUpdate\.version\}` : undefined\}/); // the update badge stays on About
});

test('About keeps the app\'s own version and protocol, app updates, storage and help, in that order', () => {
  const about = source('app/about.tsx');
  const order = ['Version {appVersion}', '<AppUpdateCard', '<SectionHeader title="Storage" />', '<SectionHeader title="Help" />',
    'title="App protocol"', 'title="Open-source notices"', 'title="Source code & help"'].map((m) => at(about, m));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  at(about, '<SectionHeader title="App updates" />');
});

test('About no longer repeats a bot\'s status, versions or Server button', () => {
  const about = source('app/about.tsx');
  assert.doesNotMatch(about, /Your bots|title="Server"|\/connection\/|runtime\[|compat|compareVersions|Winglet is behind|Update this app to connect/);
  assert.doesNotMatch(about, /AgentFace|hermes_version|server\.bot|srv\./);
});

test('the connection banner still says what to update, and its button still opens About', () => {
  const banner = source('components/ConnectionBanner.tsx');
  at(banner, "view.action === 'about' ? 'How to update'");
  at(banner, "router.push('/about')");
  const view = source('lib/connection.ts');
  at(view, "title: 'Update Winglet'"); at(view, "title: 'Update Winglet on the server'");
});

test('no date was added to Settings or About; the only time shown is when software updates were last checked', () => {
  for (const f of ['app/settings.tsx', 'app/about.tsx']) assert.doesNotMatch(source(f), /toLocale|new Date|whenText/, f);
  at(source('app/about.tsx'), 'Up to date (checked ${agoText(checkedAt / 1000)})');
});
