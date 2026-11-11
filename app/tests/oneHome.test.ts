import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * One home per concept. The menus are plain source (they need React Native to render), so this reads them, the same way
 * menuCleanup.test.ts does, and checks four things:
 *   1. a destination has ONE home among the menu surfaces (navigation / Settings / Bot page / Server page / About),
 *   2. no surface lists the same destination twice,
 *   3. every menu entry points at a screen that exists (no dead entry),
 *   4. every screen has an entry: a menu row, or a stated reason it is reached some other way (no orphan).
 * "Menu entry" means a row or button in the sidebar, the narrow rail, the sidebar's Projects section, or a row on the
 * four hub screens. A link inside some other screen's flow (a banner, a "Set up" button) is not an entry, and neither is
 * opening one particular chat (/chat/...).
 */
const SRC = new URL('../src/', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, SRC), 'utf8');

/**
 * The menu surfaces and where their entries are written. A surface is a list; its name before the colon is its HOME.
 * The sidebar and the rail are two lists with one home ("navigation"): the rail is the narrow sidebar, so the same
 * destination on both is one entry, while a repeat inside either list is a real repeat.
 */
const SURFACES: Record<string, { file: string; kind: 'sidebar' | 'rail' | 'rows' }> = {
  'navigation:sidebar': { file: 'components/AppNavigation.tsx', kind: 'sidebar' },
  'navigation:rail': { file: 'components/AppNavigation.tsx', kind: 'rail' },
  'navigation:projects': { file: 'features/projects/ProjectSection.tsx', kind: 'rows' },
  settings: { file: 'app/settings.tsx', kind: 'rows' },
  bot: { file: 'app/(tabs)/agent.tsx', kind: 'rows' },
  server: { file: 'app/server.tsx', kind: 'rows' },
  about: { file: 'app/about.tsx', kind: 'rows' },
};
const homeOf = (surface: string) => surface.split(':')[0];

/**
 * Destinations that knowingly sit on two surfaces. Each needs a reason, and the test fails if the duplicate goes away
 * (a stale allowance would hide the next real one).
 */
const SHARED: Record<string, { surfaces: string[]; why: string }> = {
  '/agent': {
    surfaces: ['navigation', 'settings'],
    why: 'The wide-screen rail has a Bot button; the sidebar has no Bot row, so on a phone the Manage card at the top of Settings is the way in.',
  },
};

/** Screens with no menu entry, and why. Each is checked: the reason must still hold (see the tests below). */
const NOT_IN_A_MENU: Record<string, { how: 'code' | 'system'; why: string }> = {
  '/assistant': { how: 'system', why: 'opened by the Android assist gesture through the winglet://assistant link' },
  '/share': { how: 'system', why: 'opened by ShareListener when another app shares to Winglet' },
  '/bots': { how: 'code', why: 'reached from the bot switcher sheet (BotSwitcher)' },
  '/connection/[serverId]': { how: 'code', why: 'opened from the connection banner when a server is unreachable' },
  '/link-device': { how: 'code', why: 'opened by scanning a link or a winglet link at launch (scan, tabs index)' },
  '/new-bot': { how: 'code', why: 'the Add a bot flow, reached from the bot switcher (AddBot)' },
  '/pair': { how: 'code', why: 'first-run connect and Add a bot flows; Redirect from screens with no server' },
  '/scan': { how: 'code', why: 'a step inside pairing and Add a device' },
  '/routine/[serverId]/[routineId]': { how: 'code', why: 'opened from an Inbox card and from a routine link (routineHref)' },
  '/routine/[serverId]/[routineId]/run/[runId]': { how: 'code', why: 'a routine link with a run id (routineHref), from an Inbox card' },
  '/session/[id]': { how: 'code', why: 'opened from a row in Sessions and from routine history' },
};

// ----------------------------------------------------------------------------------------------------- the screens

function screenFiles(dir = 'app'): string[] {
  return readdirSync(new URL(`${dir}/`, SRC), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? screenFiles(rel) : /\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/** `app/(tabs)/chats.tsx` -> `/chats`; `app/chat/[serverId]/[chatId].tsx` -> `/chat/[serverId]/[chatId]`; `(tabs)/index` -> `/`. */
function routeOf(file: string): string {
  const parts = file.replace(/^app\//, '').replace(/\.tsx?$/, '').split('/').filter((p) => !/^\(.*\)$/.test(p));
  if (parts[parts.length - 1] === 'index') parts.pop();
  return `/${parts.join('/')}`;
}

const SCREENS = screenFiles().filter((f) => !/(^|\/)_layout\.tsx?$/.test(f) && !/\+/.test(f)).map(routeOf).sort();

/** A concrete path (`/chat/${id}/home` already turned into `/chat/[x]/[x]`) matches a route with [params]. */
function screenFor(path: string): string | undefined {
  const clean = path.replace(/[?#].*$/, '');
  return SCREENS.find((route) => {
    const have = clean.split('/');
    const want = route.split('/');
    return have.length === want.length && want.every((part, i) => /^\[.*\]$/.test(part) ? !!have[i] : part === have[i]);
  });
}

// ----------------------------------------------------------------------------------------------------- the entries

const NAV_ROW = /\bnav\(\s*(?:'[^']*'|[^,()]+\?[^,()]*:\s*'[^']*'),\s*\w+,\s*'(\/[^']*)'/g;
const RAIL_ITEM = /\bitem\(\s*'[^']*',\s*\w+,\s*'(\/[^']*)'/g;
const ROW_LINK = /router\.(?:push|navigate)\(\s*(['"`])(\/[^'"`]*)\1/g;
// The sidebar footer's settings button has no row helper; it is the one entry written as a bare go('/settings').
const FOOTER = /<IconButton label="Settings" onPress=\{\(\) => go\('(\/[^']*)'\)\}/g;

/**
 * The destinations one surface sends the user to. Templates (`${id}`) become `[x]`. Opening one particular chat
 * (/chat/...) is what a chat row does, not a menu entry, so it is left out.
 */
function entriesIn(text: string, kind: 'sidebar' | 'rail' | 'rows'): string[] {
  const found: string[] = [];
  if (kind === 'sidebar') {
    for (const m of text.matchAll(NAV_ROW)) found.push(m[1]);
    for (const m of text.matchAll(FOOTER)) found.push(m[1]);
  } else if (kind === 'rail') {
    for (const m of text.matchAll(RAIL_ITEM)) found.push(m[1]);
  } else {
    for (const m of text.matchAll(ROW_LINK)) found.push(m[2].replace(/\$\{[^}]*\}/g, '[x]'));
  }
  return found.filter((p) => !p.startsWith('/chat/'));
}

/** Each surface's entries, in file order, repeats kept (a repeat inside one surface is itself a finding). */
function surfaceEntries(read: (path: string) => string = source): Record<string, string[]> {
  return Object.fromEntries(Object.entries(SURFACES).map(([name, { file, kind }]) => [name, entriesIn(read(file), kind)]));
}

/** destination -> the homes it sits on. */
function homesOf(entries: Record<string, string[]>): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  for (const [surface, paths] of Object.entries(entries)) {
    for (const path of paths) if (!(homes.get(path) ?? []).includes(homeOf(surface))) homes.set(path, [...(homes.get(path) ?? []), homeOf(surface)]);
  }
  return homes;
}

/** Everything the rules say is wrong with a set of entries; empty means fine. Kept apart so a test can feed it a broken copy. */
function problems(entries: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [surface, paths] of Object.entries(entries)) {
    for (const path of new Set(paths)) {
      // a screen that takes parameters is "open this one", written once per way of opening it; only fixed paths are menu rows
      const times = paths.filter((p) => p === path).length;
      if (!path.includes('[x]') && times > 1) out.push(`${surface} lists ${path} ${times} times`);
    }
  }
  for (const [path, homes] of homesOf(entries)) {
    const shared = SHARED[path];
    if (homes.length > 1 && !(shared && [...homes].sort().join() === [...shared.surfaces].sort().join())) {
      out.push(`${path} has ${homes.length} homes: ${homes.join(' and ')}`);
    }
    if (!screenFor(path)) out.push(`${homes.join('/')} points at ${path}, which is not a screen`);
  }
  return out;
}

/** The tab layout is a menu too: its tabs are the screens the sidebar and rail switch between. */
function tabRoutes(): string[] {
  return [...source('app/(tabs)/_layout.tsx').matchAll(/<Tabs\.Screen name="([^"]+)"/g)].map((m) => (m[1] === 'index' ? '/' : `/${m[1]}`));
}

/** Screens that nothing in a menu leads to and that have no stated reason. Opening a chat is what the chat rows do. */
function orphans(screens: string[], entries: Record<string, string[]>): string[] {
  const reached = new Set([...Object.values(entries).flat().map((p) => screenFor(p)), ...tabRoutes()]);
  return screens.filter((route) => !reached.has(route) && !NOT_IN_A_MENU[route] && !route.startsWith('/chat/'));
}

// ------------------------------------------------------------------------------------------------------ the tests

test('the parser sees the menus (a parser that finds nothing would pass every rule below)', () => {
  const entries = surfaceEntries();
  assert.ok(SCREENS.length > 30, `expected the full route list, got ${SCREENS.length}`);
  for (const [surface, paths] of Object.entries(entries)) assert.ok(paths.length >= 1, `no entries found on ${surface}`);
  assert.deepEqual([...entries['navigation:sidebar']].sort(), ['/', '/chats', '/inbox', '/rooms', '/schedule', '/settings']);
  assert.deepEqual([...entries['navigation:rail']].sort(), ['/', '/agent', '/chats', '/inbox', '/rooms', '/settings']);
  assert.ok(entries['navigation:projects'].includes('/projects'));
  for (const path of ['/about', '/appearance', '/notifications', '/wear-settings']) assert.ok(entries.settings.includes(path), `settings lost ${path}`);
  for (const path of ['/model', '/memory', '/skills', '/server', '/sessions']) assert.ok(entries.bot.includes(path), `the bot page lost ${path}`);
  for (const path of ['/devices', '/logs', '/activity']) assert.ok(entries.server.includes(path), `the server page lost ${path}`);
  assert.deepEqual(entries.about, ['/open-source-notices']);
  assert.deepEqual([...tabRoutes()].sort(), ['/', '/agent', '/chats', '/inbox']);
});

test('one home per concept: no destination sits on two menu surfaces, and none is listed twice on one', () => {
  assert.deepEqual(problems(surfaceEntries()), []);
});

test('every menu entry points at a screen that exists', () => {
  for (const [surface, paths] of Object.entries(surfaceEntries())) {
    for (const path of paths) assert.ok(screenFor(path), `${surface} points at ${path}, which is not a screen`);
  }
  for (const route of tabRoutes()) assert.ok(SCREENS.includes(route), `the tab layout lists ${route}, which is not a screen`);
});

test('the tab layout and the (tabs) folder list the same screens', () => {
  const files = screenFiles('app/(tabs)').filter((f) => !f.includes('_layout')).map(routeOf).sort();
  assert.deepEqual([...tabRoutes()].sort(), files);
});

test('every screen has an entry: a menu row, or a stated way in', () => {
  assert.deepEqual(orphans(SCREENS, surfaceEntries()), [], 'a screen needs a menu entry, or a line in NOT_IN_A_MENU saying how people reach it');
});

test('the "not in a menu" list is honest: no stale screens, no screen that has since gained a menu entry', () => {
  const inAMenu = new Set([...Object.values(surfaceEntries()).flat().map((p) => screenFor(p)), ...tabRoutes()]);
  for (const route of Object.keys(NOT_IN_A_MENU)) {
    assert.ok(SCREENS.includes(route), `${route} is listed in NOT_IN_A_MENU but is not a screen any more`);
    assert.ok(!inAMenu.has(route), `${route} now has a menu entry; take it off NOT_IN_A_MENU so it has one home`);
  }
});

test('a screen listed as reached from code is really linked from code', () => {
  const files = ['components', 'features', 'lib', 'app'].flatMap((dir) => screenFiles(dir));
  const text = files.map((f) => source(f)).join('\n');
  for (const [route, info] of Object.entries(NOT_IN_A_MENU)) {
    if (info.how !== 'code') continue;
    const first = route.split('/')[1];
    // the first path segment shows up as a quoted path, a { pathname } object, or (for routines) through routineHref
    const linked = new RegExp(`['"\`]/${first}\\b`).test(text) || (first === 'routine' && /routineHref/.test(text));
    assert.ok(linked, `${route} is said to be reached from code but nothing links to /${first}`);
  }
});

test('the shared-destination allowances are all still needed', () => {
  const homes = homesOf(surfaceEntries());
  for (const [path, info] of Object.entries(SHARED)) {
    assert.deepEqual([...(homes.get(path) ?? [])].sort(), [...info.surfaces].sort(), `${path} is no longer on exactly ${info.surfaces.join(' and ')}: remove or fix its allowance`);
    assert.ok(info.why.length > 20);
  }
});

// ---------------------------------------------- the rules must bite: feed them deliberately broken copies of the menus

const withExtra = (file: string, extra: string) => (path: string) => (path === file ? `${source(path)}\n${extra}` : source(path));

test('the rules fail on a deliberate duplicate: a second home for a destination', () => {
  const found = problems(surfaceEntries(withExtra('app/(tabs)/agent.tsx', `<ListRow title="Rooms" onPress={() => router.push('/rooms')} />`)));
  assert.ok(found.some((p) => p.includes('/rooms has 2 homes: navigation and bot')), found.join('\n'));
});

test('the rules fail on a repeat inside the sidebar alone, even for a destination the rail does not have', () => {
  const found = problems(surfaceEntries(withExtra('components/AppNavigation.tsx', `{nav('Schedule again', CalendarClock, '/schedule', () => go('/schedule'))}`)));
  assert.ok(found.some((p) => p.includes('navigation:sidebar lists /schedule 2 times')), found.join('\n'));
});

test('the rules fail on a repeat inside one hub screen', () => {
  const found = problems(surfaceEntries(withExtra('app/server.tsx', `<ListRow title="Logs again" onPress={() => router.push('/logs')} />`)));
  assert.ok(found.some((p) => p.includes('server lists /logs 2 times')), found.join('\n'));
});

test('the rules fail on a dead entry: a menu row with no screen behind it', () => {
  const found = problems(surfaceEntries(withExtra('app/settings.tsx', `<ListRow title="Gone" onPress={() => router.push('/no-such-screen')} />`)));
  assert.ok(found.some((p) => p.includes('/no-such-screen, which is not a screen')), found.join('\n'));
});

test('the rules fail when a documented duplicate quietly becomes a third home', () => {
  const found = problems(surfaceEntries(withExtra('app/server.tsx', `<ListRow title="Bot" onPress={() => router.push('/agent')} />`)));
  assert.ok(found.some((p) => p.includes('/agent has 3 homes')), found.join('\n'));
});

test('the rules fail on an orphan: a new screen with no entry and no stated way in', () => {
  assert.deepEqual(orphans([...SCREENS, '/brand-new'], surfaceEntries()), ['/brand-new']);
});

test('the rules fail on an orphan made by deleting a menu row', () => {
  // Take "Skills" off the bot page: /skills then has no entry and no reason, so it must be reported.
  const without = (path: string) => (path === 'app/(tabs)/agent.tsx' ? source(path).replace(/router\.push\('\/skills'\)/, 'undefined') : source(path));
  assert.deepEqual(orphans(SCREENS, surfaceEntries(without)), ['/skills']);
});
