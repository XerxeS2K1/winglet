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

test('Settings has no Bots section, and the bot switcher still reaches Add a bot and /bots', () => {
  const settings = source('app/settings.tsx');
  assert.doesNotMatch(settings, /title="Bots"|Your bots|Add a bot|useAddBot|'\/bots'/);
  const switcher = source('components/BotSwitcher.tsx');
  assert.match(switcher, /title="Add a bot"/);
  assert.match(switcher, /title="Manage bots"[^\n]*router\.push\('\/bots'\)/);
  assert.match(source('app/(tabs)/agent.tsx'), /<BotSwitcher \/>/); // the switcher is on the hub's bar
});

test('the Connection screen offers one way into Notifications at a time and keeps Test and the channel line', () => {
  const screen = source('app/connection/[serverId].tsx');
  // Not set up: the "Set up" button is the way in. Set up: the Quiet hours row is. Never both.
  assert.match(screen, /\{channel \? <ListRow icon=\{<Moon [^\n]*title="Quiet hours and muted chats"[^\n]*\/notifications[^\n]*: null\}/);
  assert.equal((screen.match(/title="Set up"/g) ?? []).length, 1);
  assert.match(screen, /title="Test"/);
  assert.match(screen, /On, through the \$\{channel\}/);
  assert.match(screen, /Not set up on this device/);
});

test('the chat menu no longer carries Connection details', () => {
  const menu = source('components/ChatMenu.tsx');
  assert.doesNotMatch(menu, /Connection details|\/connection\//);
  assert.match(menu, /Mute notifications/); // the rest of the menu is still there
  assert.match(menu, /Delete chat/);
});
