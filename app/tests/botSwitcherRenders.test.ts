import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from 'zustand/vanilla';
import { jsx, loadSrc, nodes, renderer } from './helpers/benchHarness.ts';

// The bot picker (the chip in the agent tab's header, and the sheet it opens) must not redraw for every token of every chat.
// Rendering is emulated (see helpers/benchHarness.ts): a component redraws only when a selector it used returns a new value.

const TOKENS = 300; // streamed updates per bot

const message = (text: string) => ({ id: 'm', chat_id: 'c', role: 'bot', status: 'streaming', text, meta: {}, created_at: 1, updated_at: 1 });
const bot = (id: string, title: string): any => ({ id, bot: { title }, profile: undefined });
const server = (over: any = {}) => ({
  status: 'online', conn: {}, compat: undefined, pending: 0, botActivity: undefined, messages: { c: [message('')] }, chats: {}, ...over,
});

function setup(initial: Record<string, any> = {}) {
  const selects: any[] = [];
  const store = createStore<any>(() => ({
    servers: [bot('a', 'Alpha'), bot('b', 'Beta')],
    runtime: { a: server({ pending: 0 }), b: server({ pending: 2, botActivity: { default: { state: 'working', queued: 1 } } }) },
    selection: { serverId: 'a' }, network: true,
    select: (...args: any[]) => { selects.push(args); },
    ...initial,
  }));
  const r = renderer(store);
  const mainFirst = (servers: any[]) => servers;
  const modules: Record<string, any> = {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'expo-router': { router: { push: () => {} } },
    'react-native': { ScrollView: 'ScrollView', StyleSheet: { create: (x: any) => x }, Text: 'Text', View: 'View' },
    'zustand/react/shallow': { useShallow: r.useShallow },
    '../lib/bots': { ...loadSrc('lib/bots.ts', {}), mainFirst },
    '../lib/connection': loadSrc('lib/connection.ts', {}),
    '../lib/prefs': { usePrefs: (fn: any) => fn({ prefs: { mainBot: undefined } }) },
    '../lib/store': { homeChat: () => 'home', useApp: r.useApp },
    '../lib/themeContext': { makeStyles: () => () => ({}), useTheme: () => ({ space: { sm: 8, md: 12, xs: 4 }, type: { caption: {} }, colors: { accent: '#00f' } }) },
    '../lib/types': {},
    './AddBot': { useAddBot: () => ({ open: () => {}, sheet: null }) },
    './AgentFace': { AgentFace: 'AgentFace' },
    './icons': { Check: 'Check', ChevronsUpDown: 'ChevronsUpDown', Plus: 'Plus', Settings: 'Settings' },
    './Sheet': { Sheet: 'Sheet' },
    './QueueSheet': { QueueSheet: 'QueueSheet' },
    './ui': { Badge: 'Badge', Chip: 'Chip', ListGroup: 'ListGroup', ListRow: 'ListRow', Tap: 'Tap' },
  };
  const mod = loadSrc('components/BotSwitcher.tsx', modules);
  const switcher = () => r.mount(() => mod.BotSwitcher());
  return { store, r, switcher, selects, modules };
}

/** The list the open sheet holds, mounted on its own with the props the switcher gave it. */
function openPicker(s: ReturnType<typeof setup>) {
  const sw = s.switcher();
  nodes(sw.tree).find((n) => n.type === 'Chip').props.onPress();
  const sheet = nodes(sw.tree).find((n) => n.type === 'Sheet');
  assert.equal(sheet.props.visible, true, 'the chip opens the sheet');
  const element = nodes(sheet).find((n) => typeof n.type === 'function' && n.type.name === 'BotList');
  assert.ok(element, 'the open sheet holds the bot list');
  const list = s.r.mount(() => element.type(element.props));
  return { sw, list };
}

const stream = (store: ReturnType<typeof createStore<any>>, serverId: string, n: number) => {
  // The store's patch(): every update replaces runtime[serverId] and the chat's message array.
  store.setState((st: any) => ({ runtime: { ...st.runtime, [serverId]: { ...st.runtime[serverId], messages: { c: [message(`word ${n}`)] } } } }));
};
const describeRows = (tree: any) => nodes(tree).filter((n) => n.type === 'ListRow').map((n) => {
  const inner = nodes(n.props.right);
  return {
    title: n.props.title, value: n.props.value, subtitle: n.props.subtitle,
    queue: inner.some((x) => x.type === 'Tap'), badge: inner.find((x) => x.type === 'Badge')?.props.count, current: inner.some((x) => x.type === 'Check'),
  };
});

test('the closed picker chip does not redraw while chats stream', () => {
  const s = setup();
  const sw = s.switcher();
  const before = sw.renders;
  for (let i = 0; i < TOKENS; i++) { stream(s.store, 'a', i); stream(s.store, 'b', i); }
  const after = sw.renders - before;
  console.log(`BENCH item1 closed chip: ${after} renders for ${TOKENS * 2} streamed updates`);
  assert.equal(after, 0);
});

test('the chip still shows the number waiting on the other bots, and updates when that changes', () => {
  const s = setup();
  const sw = s.switcher();
  const badge = () => nodes(sw.tree).find((n) => n.type === 'Badge')?.props.count;
  assert.equal(badge(), 2);
  s.store.setState((st: any) => ({ runtime: { ...st.runtime, b: { ...st.runtime.b, pending: 5 } } }));
  assert.equal(badge(), 5);
  s.store.setState((st: any) => ({ runtime: { ...st.runtime, b: { ...st.runtime.b, pending: 0 } } }));
  assert.equal(badge(), undefined, 'no badge at zero');
  s.store.setState((st: any) => ({ runtime: { ...st.runtime, a: { ...st.runtime.a, pending: 9 } } }));
  assert.equal(badge(), undefined, "this bot's own pending is not counted in 'others'");
  s.store.setState({ selection: { serverId: 'b' } });
  assert.equal(badge(), 9, 'switching the current bot changes whose count is shown');
  assert.equal(nodes(sw.tree).find((n) => n.type === 'Chip').props.label, 'Beta');
});

test('an open picker does not redraw while chats stream, and still shows each bot as before', () => {
  const s = setup();
  const { sw, list } = openPicker(s);
  assert.deepEqual(describeRows(list.tree), [
    { title: 'Alpha', value: 'Main', subtitle: 'Online', queue: false, badge: undefined, current: true },
    { title: 'Beta', value: undefined, subtitle: 'Working, 1 queued', queue: true, badge: 2, current: false },
  ]);
  const [swBefore, listBefore] = [sw.renders, list.renders];
  for (let i = 0; i < TOKENS; i++) { stream(s.store, 'a', i); stream(s.store, 'b', i); }
  console.log(`BENCH item1 open picker: chip ${sw.renders - swBefore} renders, list ${list.renders - listBefore} renders for ${TOKENS * 2} streamed updates`);
  assert.equal(sw.renders - swBefore, 0);
  assert.equal(list.renders - listBefore, 0);
});

test('an open picker still follows what it shows: connection, activity, waiting count, queue link', () => {
  const s = setup();
  const { list } = openPicker(s);
  const set = (id: string, over: any) => s.store.setState((st: any) => ({ runtime: { ...st.runtime, [id]: { ...st.runtime[id], ...over } } }));
  const beta = () => describeRows(list.tree)[1];
  set('b', { botActivity: { default: { state: 'idle', queued: 0 } } });
  assert.equal(beta().subtitle, 'Online');
  assert.equal(beta().queue, true, 'any activity record offers the queue');
  set('b', { botActivity: undefined });
  assert.equal(beta().queue, false);
  set('b', { botActivity: { default: { state: 'working', queued: 3 } } });
  assert.equal(beta().subtitle, 'Working, 3 queued');
  set('b', { pending: 7 });
  assert.equal(beta().badge, 7);
  set('b', { status: 'offline', conn: { nextRetryAt: 1 } });
  assert.deepEqual([beta().subtitle, beta().queue], ["Can't reach Beta", false], 'offline: the reason, no queue link');
  set('b', { status: 'unauthorized' });
  assert.equal(beta().subtitle, 'Signed out');
  set('b', { status: 'online', compat: 'update-app' });
  assert.equal(beta().subtitle, 'Update Winglet');
  set('b', { compat: undefined });
  assert.equal(beta().subtitle, 'Working, 3 queued');
  s.store.setState({ network: false });
  assert.equal(beta().subtitle, 'Working, 3 queued', 'an open connection is online whatever Android says');
  set('b', { status: 'connecting' });
  assert.equal(beta().subtitle, 'No internet');
  set('b', { status: 'connecting', conn: { recovering: true } });
  s.store.setState({ network: true });
  assert.equal(beta().subtitle, "Finding Beta's new address");
  s.store.setState((st: any) => ({ servers: [...st.servers, bot('c', 'Gamma')], runtime: { ...st.runtime, c: server() } }));
  assert.deepEqual(describeRows(list.tree).map((r) => r.title), ['Alpha', 'Beta', 'Gamma'], 'a bot added while open appears');
});

test('picking another bot from the list selects it', () => {
  const s = setup();
  const { list } = openPicker(s);
  const rows = nodes(list.tree).filter((n) => n.type === 'ListRow');
  rows[1].props.onPress();
  assert.deepEqual(s.selects, [['b', 'home']]);
});
