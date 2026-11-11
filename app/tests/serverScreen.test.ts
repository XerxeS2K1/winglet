import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// The single Server screen. These read the source because the screens need React Native to run.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const at = (text: string, marker: string) => {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  return i;
};

test('the Server screen has its sections in order: status, health, controls, reaching it, updates, devices, tools', () => {
  const screen = source('app/server.tsx');
  const order = ['<StatusCard', '<SectionHeader title="Health"', '<SectionHeader title="Controls"', '<ReachingIt',
    '<SectionHeader title="Updates"', '<ServerAutoUpdateCard', '<SectionHeader title="Devices"', '<SectionHeader title="Tools"',
    'title="Logs"', 'title="Activity"'].map((m) => at(screen, m));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.doesNotMatch(screen, /Notification settings|Quiet hours/); // notifications keep their one entry elsewhere
});

test('Reaching it keeps everything the Connection screen showed', () => {
  const part = source('components/ReachingIt.tsx');
  for (const marker of ['title="Reaching it"', 'Notifications', 'MoveSheet', 'hideDetails']) at(part, marker);
  at(part, 'export function ReachingIt');
});

test('the owner-only parts of the Server screen stay gated, and a child bot reaches its parent\'s address', () => {
  const screen = source('app/server.tsx');
  at(screen, "const child = !!server?.parent;");
  at(screen, "const canControl = !!rt?.info?.features?.control && isOwner(rt) && !child;");
  for (const gated of ['{canControl ? <StatusCard', '{canControl ? <SectionHeader title="Controls"', '{canControl ? <><SectionHeader title="Tools"', '{canControl && info?.jobs.length']) at(screen, gated);
  at(screen, 'const reach = (child ? servers.find((x) => x.id === server?.parent) : undefined) ?? server;');
  at(screen, '{reach ? <ReachingIt server={reach} showVersions={!canControl} /> : null}');
  at(screen, '{isOwner(rt) ? <ServerAutoUpdateCard /> : null}'); // the plugin switch stays owner only
  at(screen, '{!child && rt?.info?.features?.roles ? (');          // Devices keeps its old gate
  at(screen, 'if (canControl) check()');                              // no owner-only requests for other phones
});

test('the hub has one Server row and no Status, Connection, Devices rows or version footnote', () => {
  const hub = source('app/(tabs)/agent.tsx');
  assert.equal((hub.match(/title="Server"/g) ?? []).length, 1); // the row; no header repeating it
  at(hub, "router.push('/server')");
  assert.doesNotMatch(hub, /title="Status"|title="Connection"|title="Devices"|\/connection\/|'\/devices'|Server plugin|Footnote/);
  at(hub, 'title="Bot configuration"'); // owner-only, unchanged
  at(hub, '<SectionHeader title="Abilities" />'); at(hub, '<SectionHeader title="History" />');
});

test('About keeps the app\'s own updates, storage and help, and loses the server updates and server versions', () => {
  const about = source('app/about.tsx');
  at(about, 'title="App updates"'); at(about, 'title="Storage"'); at(about, 'title="Help"');
  assert.doesNotMatch(about, /Server updates|ServerAutoUpdateCard|ServerVersion|hermes_version|Winglet on server/);
  assert.ok(existsSync(new URL('../src/components/ServerAutoUpdate.tsx', import.meta.url)));
});

test('the server\'s plugin and Hermes versions are shown in one place each', () => {
  const users = (re: RegExp) => ['app', 'components'].flatMap((dir) => readdirSync(new URL(`../src/${dir}`, import.meta.url), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx$/.test(e.name)).map((e) => `${dir}/${e.name}`)).filter((f) => re.test(source(f)));
  assert.deepEqual(users(/hermes_version/).sort(), ['app/server.tsx', 'components/ReachingIt.tsx']);
  // ReachingIt only adds the version rows when the Status card (which already has them) is hidden.
  const part = source('components/ReachingIt.tsx');
  at(part, '...(showVersions ? [');
  at(source('app/server.tsx'), 'showVersions={!canControl}');
});

test('the old Connection route redirects to the Server screen after selecting that bot', () => {
  const route = source('app/connection/[serverId].tsx');
  at(route, 'app.select(serverId, homeChat(app.runtime[serverId]))');
  at(route, '<Redirect href="/server" />');
  at(route, '<Redirect href="/" />'); // an unknown bot still goes home
  assert.doesNotMatch(route, /<Screen/);
});

test('every entry point to Connection, Devices and the Server screen still lands somewhere', () => {
  at(source('components/ConnectionBanner.tsx'), '`/connection/${server.id}`');
  assert.doesNotMatch(source('app/about.tsx'), /\/connection\//); // About's bot cards (and their Server button) are gone; the bot page has the Server row
  at(source('app/settings.tsx'), "router.push('/agent')");           // Settings' bot card reaches the bot page
  at(source('app/server.tsx'), "router.push('/devices')");
  for (const route of ['app/server.tsx', 'app/devices.tsx', 'app/connection/[serverId].tsx']) assert.ok(existsSync(new URL(`../src/${route}`, import.meta.url)), route);
});
