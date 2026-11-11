import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Menu PR 4: the wording pass. Each test names the audit finding it pins (wording-audit-2026-11-11.md). These read the
// source because the screens need React Native to run; every marker must be found or the check means nothing.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const has = (text: string, marker: string) => { assert.ok(text.includes(marker), `marker not found: ${marker}`); };
const lacks = (text: string, marker: string) => { assert.ok(!text.includes(marker), `old wording still present: ${marker}`); };

test('decision 1: the bottom tab that opens the bot page is called Bot', () => {
  const tabs = source('app/(tabs)/_layout.tsx');
  has(tabs, `<Tabs.Screen name="agent" options={{ title: 'Bot' }} />`);
  lacks(tabs, `title: 'Agent'`);
});

test('decision 2 (finding 2): one name for adding a phone, Add a device, with Approve a browser for the QR step', () => {
  const devices = source('app/devices.tsx');
  has(devices, '<SectionHeader title="Add a device" />'); has(devices, '<ListRow title="Add a device"');
  has(devices, 'title="Approve a browser"');
  for (const old of ['Link a device', 'Scan browser QR']) lacks(devices, old);
  const pair = source('app/pair.tsx');
  has(pair, "showInstall ? 'Install Winglet' : result ? 'Connection' : hasServers ? 'Add a device' : 'Connect to your server'");
  has(pair, 'title="Connect"');
  for (const old of ['Connect Winglet', 'Link a device', 'Connect and verify']) lacks(pair, old);
  const browser = source('components/BrowserSignIn.tsx');
  has(browser, 'Devices → Add a device → Approve a browser');
  for (const old of ['Link a device', 'Scan browser QR']) lacks(browser, old);
});

test('finding 1: the new-bot screen button says Add bot, not Create bot', () => {
  const screen = source('app/new-bot.tsx');
  has(screen, '<Screen title="Add a bot"'); has(screen, '<Button title="Add bot"'); lacks(screen, 'Create bot');
});

test('finding 3: the create-routine button is Save routine, not Schedule it', () => {
  const screen = source('app/schedule.tsx');
  has(screen, "form.id ? 'Save' : 'Save routine'"); lacks(screen, 'Schedule it');
});

test('finding 4: the Model row opens a screen called Model', () => {
  has(source('app/model.tsx'), '<Screen title="Model"'); lacks(source('app/model.tsx'), 'Default model');
  has(source('app/(tabs)/agent.tsx'), 'title="Model"');
});

test('finding 4b: the bot page and its settings screen use Bot, not Agent', () => {
  const agent = source('app/(tabs)/agent.tsx');
  has(agent, '<SectionHeader title="Bot" />');
  has(agent, 'title="Bot configuration"');
  lacks(agent, 'title="Agent"');
  has(source('app/advanced-config.tsx'), '<Screen title="Bot configuration"');
  lacks(source('app/advanced-config.tsx'), 'Agent configuration');
});

test('finding 5: the chat list tab, sidebar and header all say All chats', () => {
  has(source('app/(tabs)/_layout.tsx'), `<Tabs.Screen name="chats" options={{ title: 'All chats' }} />`);
  has(source('app/(tabs)/_layout.tsx'), `<Tabs.Screen name="index" options={{ title: 'Chat' }} />`);
  has(source('components/AppNavigation.tsx'), "nav('All chats'"); has(source('app/(tabs)/chats.tsx'), "'All chats'");
});

test('finding 3 / sidebar: the sidebar bot destination is called Bot', () => {
  const nav = source('components/AppNavigation.tsx');
  has(nav, "item('Bot', Bot, '/agent')");
  lacks(nav, "item('Agent', Bot, '/agent')");
});


test('finding 7: jargon replaced in about, rooms, logs and devices', () => {
  const about = source('app/about.tsx');
  has(about, 'title="App/server protocol version"');
  lacks(about, 'title="App protocol"');
  has(source('features/rooms/RoomsScreen.tsx'), 'Update the server to use rooms.');
  has(source('app/logs.tsx'), "label: 'Server'");
  has(source('app/devices.tsx'), 'Update the Winglet plugin on the server, then restart it to enable devices and roles.');
});

test('finding 8: the bot delete button is Delete bot; device removal stays Remove', () => {
  const bots = source('app/bots.tsx');
  has(bots, "title={confirm === srv.id ? 'Delete bot' : ''}");
  has(bots, 'accessibilityLabel={confirm === srv.id ? `Confirm deleting ${srv.bot.title}` : `Delete ${srv.bot.title}`}');
  has(bots, '<Screen title="Bots">');
  has(bots, "Bots can't ask each other for help on this server yet.");
  lacks(bots, "Your bots can't ask each other");
  has(source('app/devices.tsx'), 'label={d.current ? \'Remove this phone\' : \'Remove\'}');
});

test('finding 9: browser sign-in screen uses Cancel sign-in, not Close', () => {
  const link = source('app/link-device.tsx');
  has(link, 'title="Cancel sign-in"');
  lacks(link, 'title="Close"');
});

test('finding 10: Paired and Started rows are dropped, last-seen and activity stay', () => {
  lacks(source('app/devices.tsx'), '<ListRow title="Paired"');
  const session = source('app/session/[id].tsx');
  lacks(session, '<ListRow title="Started"');
  lacks(session, '<SectionHeader title="Session"');
  has(session, "title={session ? sessionTitle(session) : 'Chat history'}");
  has(source('app/devices.tsx'), 'seen ${agoText(d.last_seen)}');
});

test('finding 11: Inbox and notification empty text use reports, not results', () => {
  has(source('components/InboxView.tsx'), 'Approvals, questions and reports appear here.');
  has(source('app/notifications.tsx'), 'Notify me about approvals, questions and reports.');
});

test('finding 12: the diagnostic button is Copy diagnostics', () => {
  has(source('components/ReachingIt.tsx'), 'Copy diagnostics');
  lacks(source('components/ReachingIt.tsx'), 'Copy report');
});

test('finding 13: the sessions list calls the section Chats and the empty state No chats yet', () => {
  const sessions = source('app/sessions.tsx');
  has(sessions, "title={searching ? 'Search results' : 'Chats'}");
  has(sessions, "'No chats yet.'");
  lacks(sessions, "'Conversations'");
});

test('finding 6b: rooms and wear sections also use Chats', () => {
  has(source('features/rooms/RoomsScreen.tsx'), '<SectionHeader title="Chats"');
  lacks(source('features/rooms/RoomsScreen.tsx'), 'title="Conversations"');
  const wear = source('features/wear/Settings.tsx');
  has(wear, '<SectionHeader title="Chats"');
  lacks(wear, 'title="Conversations"');
  has(wear, 'Refresh on the watch to see shared chats.');
  has(wear, 'chats selected');
  has(wear, "title=\"Chat limit\"");
  lacks(wear, 'shared conversations');
  lacks(wear, 'conversations selected');
  lacks(wear, 'Conversation limit');
});

test('finding 14: the server-screen notifications row is Notifications', () => {
  has(source('components/ReachingIt.tsx'), 'title="Notifications"');
  lacks(source('components/ReachingIt.tsx'), 'title="Notification settings"');
});

test('finding 7: encrypted push uses plain words outside diagnostics', () => {
  const push = source('features/encrypted-push/Settings.tsx');
  has(push, "setMessage('Waiting for your push service…')");
  has(push, "'The push service could not register this phone.");
  has(push, "title={rotate?'Rotate key':'Push service'}");
  has(push, "'A delivery could not be verified.");
  has(push, "'An oversized message was refused.");
  has(push, "'Only encrypted messages pass through this service, never your credentials or delivery key.'");
  lacks(push, "'Waiting for your push distributor…'");
  lacks(push, "title={rotate?'Rotate key':'Push distributor'}");
  lacks(push, "'A payload could not be verified.");
  lacks(push, "'An oversized payload was refused.");
  lacks(push, "'Only encrypted payloads pass through this distributor");
});

test('finding 15: Bot switcher and screen use Bots; devices Activity section is Activity', () => {
  const switcher = source('components/BotSwitcher.tsx');
  has(switcher, 'title="Bots"');
  has(switcher, 'accessibilityLabel="Bots"');
  lacks(switcher, 'title="Your bots"');
  has(source('app/devices.tsx'), '<SectionHeader title="Activity" />');
});
