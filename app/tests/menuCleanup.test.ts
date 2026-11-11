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
  assert.match(hub, /title="Server"[\s\S]{0,120}router\.push\('\/server'\)/); // Devices now sits on the Server screen
  const settings = source('app/settings.tsx');
  const from = settings.indexOf('<SectionHeader title="App" />');
  assert.ok(from >= 0, 'the App group marker must be found, or this slice means nothing');
  const app = settings.slice(from);
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
  const screen = source('components/ReachingIt.tsx');
  // Not set up: the "Set up" button is the way in. Set up: the Quiet hours row is. Never both.
  assert.match(screen, /\{channel \? <ListRow icon=\{<Moon [^\n]*title="Notification settings"[^\n]*\/notifications[^\n]*: null\}/);
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

test('the Agent hub has one button, Open chat, at full width: the feed is linked from Chats and Schedule instead', () => {
  const hub = source('app/(tabs)/agent.tsx');
  assert.doesNotMatch(hub, /title="Updates"|title="Reports"|\/home`/);
  const start = hub.indexOf('<View style={s.actions}>');
  assert.ok(start >= 0, 'the hub header action row must be found');
  const row = hub.slice(start, hub.indexOf('</View>', start));
  assert.ok(row.includes('title="Open chat"'), 'the action row must contain Open chat');
  assert.equal((row.match(/<Button /g) ?? []).length, 1);
  assert.match(source('app/(tabs)/chats.tsx'), /open\('home'\)/); // the Chats list pill is still the way in
  assert.match(source('app/schedule.tsx'), /\/chat\/\$\{server\.id\}\/home/); // and Schedule's button
});

test('the feed (kind home) is called Reports wherever the app names it; Updates is left for software updates', () => {
  const files = ['lib/agent.ts', 'components/ChatView.tsx', 'components/InboxView.tsx', 'app/notifications.tsx',
    'app/schedule.tsx', 'app/(tabs)/chats.tsx'];
  for (const f of files) assert.doesNotMatch(source(f), /'Updates'|title="Updates"|>Updates<|Open Updates|Open updates|in Updates\.|Updates chat/, f);
  assert.match(source('lib/agent.ts'), /kind === 'home' \? 'Reports'/);
  assert.match(source('app/(tabs)/chats.tsx'), /accessibilityLabel="Open reports"/);
  assert.match(source('app/schedule.tsx'), /title="Open Reports"/);
  assert.match(source('app/schedule.tsx'), /posts its result in Reports\./);
  // Software updates keep their name.
  assert.match(source('app/server.tsx'), /<SectionHeader title="Updates"/);
  assert.match(source('app/about.tsx'), /title="App updates"/);
  assert.match(source('app/server.tsx'), /<ServerAutoUpdateCard \/>/);
  // The route and chat kind are identifiers, not words the user sees.
  assert.match(source('app/schedule.tsx'), /\/chat\/\$\{server\.id\}\/home/);
});

test('searching Chats finds the feed by its shown name, Reports, and no longer by Updates', () => {
  const chats = source('app/(tabs)/chats.tsx');
  assert.match(chats, /import \{ ago, chatName \} from '\.\.\/\.\.\/lib\/agent'/);
  assert.match(chats, /const match = \(c: Chat\) => [^\n]*\$\{chatName\(c\)\} \$\{c\.preview\}/); // not c.title, which the server stores as Updates
  assert.doesNotMatch(chats, /const match = [^\n]*\$\{c\.title\}/);
  const agent = source('lib/agent.ts');
  assert.match(agent, /chat\.kind === 'home' \? 'Reports' : chat\.title/);
});
