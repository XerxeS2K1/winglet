import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Menu clean-up: one home per concept. These read the screen source because the screens need React Native to run.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the Agent hub no longer lists Schedule or Logs, and its history group is called History', () => {
  const hub = source('app/(tabs)/agent.tsx');
  assert.doesNotMatch(hub, /title="Schedule"|title="Logs"|'\/schedule'|'\/logs'/);
  assert.match(hub, /title="History"/);
  assert.doesNotMatch(hub, /Automation & history/);
  assert.match(hub, /key="checkpoints"/);
  assert.match(hub, /key="sessions"/);
});

test('the Server screen no longer lists Schedule but keeps Logs and Activity', () => {
  const server = source('app/server.tsx');
  assert.doesNotMatch(server, /title="Schedule"|'\/schedule'/);
  assert.match(server, /title="Logs"/);
  assert.match(server, /title="Activity"/);
});

test('"Open the app on" moved from the Agent hub to the App group in Settings, with the same behaviour', () => {
  const hub = source('app/(tabs)/agent.tsx');
  assert.doesNotMatch(hub, /Open the app on|setMainBot|useMainBot/);
  assert.match(hub, /title="Devices"/); // the Access group keeps Devices
  const settings = source('app/settings.tsx');
  const app = settings.slice(settings.indexOf('<SectionHeader title="App" />'), settings.indexOf('title="On this phone"'));
  assert.match(app, /title="Open the app on"/);
  assert.match(app, /value=\{server\.bot\.title\}/);
  assert.match(app, /mainBot\?\.id === server\.id \? undefined : \(\) => setMainBot\(server\.id\)/);
  assert.match(settings, /import \{ setMainBot, useMainBot \} from '\.\.\/lib\/mainBot'/);
});
