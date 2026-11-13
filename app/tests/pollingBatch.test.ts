import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as model from '../src/features/routine-history/model.ts';
import { repairEncryptedPush } from '../src/features/encrypted-push/repair.ts';
import { startWearPolling } from '../src/features/wear/polling.ts';
import { fallback, hookRuntime, settle } from './helpers/hookHarness.ts';

// Five polling and re-render fixes (issues 44, 45, 50, 51, 52). Where a screen cannot run here (it needs React Native) the
// hook logic is run in a small stand-in for React's hooks (tests/helpers/hookHarness.ts); that is not a device test.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

// ---- #45: one-second clocks live in leaf components -------------------------------------------------------------------
test('#45 the Reaching-it section and the sign-in screen no longer hold a once-a-second state of their own', () => {
  const reaching = source('components/ReachingIt.tsx');
  assert.doesNotMatch(reaching, /setNow|useState\(Date\.now\(\)\)/);
  const main = reaching.slice(0, reaching.indexOf('function recoveryState'));
  assert.doesNotMatch(main, /\bnow\s*[-,)]|\bnow\b\s*=|\{now\}/); // the section itself never reads the clock (the words "right now" are text)
  for (const leaf of ['StatusRow', 'AddressAge', 'RecentEvents', 'RecoveryRow', 'TunnelRow', 'Notifications']) {
    const body = reaching.slice(reaching.indexOf(`function ${leaf}(`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /useNow\(\)/, `${leaf} should own its clock`);
  }
  assert.doesNotMatch(source('app/link-device.tsx'), /setNow|setInterval/);
  assert.doesNotMatch(source('app/connection/[serverId].tsx'), /setInterval|setNow|Date\.now/); // now a plain redirect
});

test('#45 the sign-in expiry check re-renders the screen once, when the request expires, not every second', () => {
  const h = hookRuntime();
  const { useExpired } = h.load('lib/useNow.ts', {});
  const run = (expiresAt: number | null, active: boolean) => h.render(() => useExpired(expiresAt, active));
  assert.equal(run(null, false), false);
  assert.equal(h.live().length, 0);                  // no timer until there is a request to watch
  const expiresAt = h.clock.now + 5_000;
  assert.equal(run(expiresAt, true), false);
  assert.equal(h.live().length, 1);
  const before = h.stats().stateWrites;
  for (let i = 0; i < 3; i++) { h.clock.now += 1000; h.timers[0].fn(); } // three ticks before expiry
  assert.equal(h.stats().stateWrites, before);       // no state change, so no re-render
  h.clock.now = expiresAt; h.timers[0].fn();
  assert.equal(h.stats().stateWrites, before + 1);   // exactly one, at expiry
  assert.equal(h.timers[0].cleared, true);           // and the timer stops itself
  assert.equal(run(expiresAt, true), true);
  assert.equal(h.live().length, 0);
  assert.equal(run(h.clock.now + 60_000, true), false); // a new, later request is not expired (the value is not sticky)
  assert.equal(h.live().length, 1);
  assert.equal(run(h.clock.now + 60_000, false), false); // stops watching when no longer active
});
test('#45 useNow is the leaf clock: it ticks its own component once a second and stops on unmount', () => {
  const h = hookRuntime();
  const { useNow } = h.load('lib/useNow.ts', {});
  h.clock.now = 5000;
  assert.equal(h.render(() => useNow()), 5000);
  h.clock.now = 6000; h.timers[0].fn();
  assert.equal(h.render(() => useNow()), 6000);
  assert.equal(h.timers[0].ms, 1000); assert.equal(h.live().length, 1);
});

// ---- #50: encrypted-push repair ---------------------------------------------------------------------------------------
const server = (id: string, extra: object = {}) => ({ id, deviceId: `${id}-dev`, ...extra });
test('#50 two repair passes never run at once, even from separate effect runs', async () => {
  let release!: () => void;
  const synced: string[] = [];
  let statusCalls = 0;
  const ports = (signal: AbortSignal) => ({
    signal, servers: [server('a')], online: 'a',
    status: async () => { statusCalls++; return { active: true, needsSync: true }; },
    sync: async (s: { id: string }) => { synced.push(s.id); await new Promise<void>((r) => { release = r; }); },
  });
  const first = repairEncryptedPush(ports(new AbortController().signal));
  await settle();
  await repairEncryptedPush(ports(new AbortController().signal)); // a second effect run while the first is syncing
  assert.equal(statusCalls, 1);
  assert.deepEqual(synced, ['a']);
  release(); await first;
  const third = repairEncryptedPush(ports(new AbortController().signal));
  await settle();
  assert.equal(statusCalls, 2); // the flag was released, so a later pass runs
  release(); await third;
});

test('#50 repair skips child and offline bots, needs an active enrollment, and releases the flag after an abort or an error', async () => {
  const synced: string[] = [];
  const base = {
    servers: [server('a'), server('b'), server('c', { parent: 'a' }), server('d')], online: 'a|c|d',
    status: async (id: string) => { if (id === 'd') throw new Error('native failure'); return { active: id === 'a', needsSync: true }; },
    sync: async (s: { id: string }) => { synced.push(s.id); },
  };
  await repairEncryptedPush({ ...base, signal: new AbortController().signal });
  assert.deepEqual(synced, ['a']); // b offline, c is a child, d failed and was ignored
  const aborted = new AbortController(); aborted.abort();
  await repairEncryptedPush({ ...base, signal: aborted.signal });
  assert.deepEqual(synced, ['a']);
  const live = new AbortController();
  await repairEncryptedPush({ ...base, signal: live.signal, status: async () => { live.abort(); return { active: true, needsSync: true }; } });
  assert.deepEqual(synced, ['a']); // aborted mid-pass: no sync
  await repairEncryptedPush({ ...base, signal: new AbortController().signal });
  assert.deepEqual(synced, ['a', 'a']); // flag was released each time
});

test('#50 a store write that leaves the online server ids alone does not restart the repair timer', () => {
  const h = hookRuntime();
  const lock = { locked: false, hiddenAt: 0 };
  const appState: any = { ready: true, foreground: true, servers: [{ id: 'a', deviceId: 'd', url: 'https://x', token: 't' }], runtime: { a: { status: 'online' } } };
  const store = (st: any) => Object.assign((sel: any) => sel(st), { getState: () => st });
  const calls: string[] = [];
  const mod = h.load('features/encrypted-push/SecurityBridge.tsx', {
    'react-native': { Platform: { OS: 'android' } },
    '../../lib/push': {}, '../../lib/appLock': { useLock: store(lock) },
    '../../lib/prefs': { usePrefs: store({ loaded: true, prefs: { appLock: false } }) },
    '../../lib/store': { useApp: store(appState) },
    './native': { pushNative: { security: () => {}, retain: async () => {}, status: async (id: string) => { calls.push(id); return { active: false }; } } },
    './api': { syncEncryptedPush: async () => {} }, './repair': { repairEncryptedPush },
  });
  h.render(mod.PushSecurityBridge);
  assert.equal(h.timers.length, 1);
  appState.servers = [{ ...appState.servers[0] }];            // any store write replaces the servers array
  h.render(mod.PushSecurityBridge);
  appState.servers = [{ ...appState.servers[0], url: 'https://x' }];
  h.render(mod.PushSecurityBridge);
  assert.equal(h.timers.length, 1);                           // still the first timer
  assert.equal(h.live().length, 1);
  appState.runtime = { a: { status: 'offline' } };            // the online set really changed
  h.render(mod.PushSecurityBridge);
  assert.equal(h.timers.length, 2);
  assert.equal(h.live().length, 1);
});

// ---- #51: wear settings poll -------------------------------------------------------------------------------------------
const clockPorts = () => {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return { timers, setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (id: number) => { timers[id].cleared = true; } };
};
test('#51 no timer starts when the watch setup is unsupported', async () => {
  const c = clockPorts(); let refreshes = 0;
  startWearPolling({ refresh: async () => { refreshes++; return false; }, busy: () => false, ...c });
  await settle();
  assert.equal(refreshes, 1); assert.equal(c.timers.length, 0);
});
test('#51 when supported it polls every 3 s, skips ticks while an action runs, and stops on cleanup', async () => {
  const c = clockPorts(); let refreshes = 0, busy = false;
  const stop = startWearPolling({ refresh: async () => { refreshes++; return true; }, busy: () => busy, ...c });
  await settle();
  assert.equal(c.timers.length, 1); assert.equal(c.timers[0].ms, 3000); assert.equal(refreshes, 1);
  c.timers[0].fn(); assert.equal(refreshes, 2);
  busy = true; c.timers[0].fn(); c.timers[0].fn(); assert.equal(refreshes, 2); // an action is in flight
  busy = false; c.timers[0].fn(); assert.equal(refreshes, 3);
  stop(); assert.equal(c.timers[0].cleared, true);
});
test('#51 leaving the screen before the first check finishes starts no timer', async () => {
  const c = clockPorts(); let finish!: (v: boolean) => void;
  const stop = startWearPolling({ refresh: () => new Promise<boolean>((r) => { finish = r; }), busy: () => false, ...c });
  stop(); finish(true); await settle();
  assert.equal(c.timers.length, 0);
});
test('#51 losing support stops the existing timer and prevents further refreshes', async () => {
  const c = clockPorts(), later = deferred<boolean>(); let refreshes = 0;
  startWearPolling({ refresh: () => { refreshes++; return refreshes === 1 ? Promise.resolve(true) : later.promise; }, busy: () => false, ...c });
  await settle(); assert.equal(c.timers.length, 1);
  c.timers[0].fn(); assert.equal(refreshes, 2);
  later.resolve(false); await settle();
  assert.equal(c.timers[0].cleared, true);
  c.timers[0].fn(); await settle(); assert.equal(refreshes, 2); // even an already-queued tick is inert
});
test('#51 cleanup while a later refresh awaits keeps the timer stopped', async () => {
  const c = clockPorts(), later = deferred<boolean>(); let refreshes = 0;
  const stop = startWearPolling({ refresh: () => { refreshes++; return refreshes === 1 ? Promise.resolve(true) : later.promise; }, busy: () => false, ...c });
  await settle(); c.timers[0].fn(); stop();
  later.resolve(true); await settle();
  assert.equal(c.timers.length, 1); assert.equal(c.timers[0].cleared, true);
  c.timers[0].fn(); await settle(); assert.equal(refreshes, 2);
});
test('#51 the Wear screen uses it instead of its own always-on interval', () => {
  const wear = source('features/wear/Settings.tsx');
  assert.doesNotMatch(wear, /setInterval/);
  assert.match(wear, /startWearPolling\(\{refresh,busy:\(\)=>!!action\.current\}\)/);
});

// ---- #52: routine run detail -------------------------------------------------------------------------------------------
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function runHarness(initial: string | Error | Promise<string>) {
  const h = hookRuntime();
  const api: { n: number; next: string | Error | Promise<string> } = { n: 0, next: initial };
  const rt: any = { status: 'online', info: { features: { routine_history: true } }, me: { role: 'owner' } };
  const srv = { id: 'bot', url: 'https://x' };
  const route = { serverId: 'bot', routineId: 'job', runId: 'r1' };
  const store = Object.assign((sel: any) => sel({ servers: [srv] }), { getState: () => ({}) });
  const mod = h.load('features/routine-history/RoutinePages.tsx', {
    'expo-router': { useLocalSearchParams: () => route, useFocusEffect: () => {}, router: {} },
    'react-native': { Text: 'Text', View: 'View' },
    '../../lib/store': { useApp: store, useServerState: () => rt, isOwner: (r: any) => r.me.role === 'owner' },
    '../../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    '../../lib/api': { api: async () => { api.n++; if (api.next instanceof Error) throw api.next; return { run: { id: 'r1', status: await api.next, recorded: true } }; }, signedApi: async () => {} },
    '../../components/Screen': { Screen: 'Screen' }, '../../components/ui': { Button: 'Button', Card: 'Card', ListGroup: 'ListGroup', ListRow: 'ListRow', LoadError: 'LoadError', SectionHeader: 'SectionHeader', Skeleton: 'Skeleton', Tap: 'Tap' },
    './model': model,
  }, '\nexport { RecordedRun };');
  return { h, api, rt, route, render: () => h.render(mod.RecordedRun) };
}
test('#52 pulls during a pending load coalesce into one follow-up, even when that load finishes the run', async () => {
  const first = deferred<string>(), second = deferred<string>();
  const r = runHarness(first.promise);
  const tree: any = r.render();
  tree.props.onRefresh(); tree.props.onRefresh(); tree.props.onRefresh();
  r.h.timers[0].fn();
  assert.equal(r.api.n, 1); // no parallel manual or poll request
  r.api.next = second.promise;
  first.resolve('completed'); await settle();
  assert.equal(r.api.n, 2); // manual work survives finished-run suppression
  r.h.timers[0].fn(); await settle(); assert.equal(r.api.n, 2);
  second.resolve('completed'); await settle();
  assert.equal(r.api.n, 2); // repeated pulls were coalesced, not counted
  r.h.timers[0].fn(); await settle(); assert.equal(r.api.n, 2);
  assert.equal(r.h.timers.length, 1); assert.equal(r.h.live()[0].ms, 5000);
});

test('#52 Retry during a pending retry queues one attempt after failure', async () => {
  const r = runHarness(new Error('offline'));
  r.render(); await settle();
  const tree: any = r.render();
  const find = (node: any): any => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'LoadError') return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child); if (found) return found; }
  };
  const retry = find(tree).props.onRetry;
  const pending = deferred<string>(); r.api.next = pending.promise;
  retry(); retry(); retry(); assert.equal(r.api.n, 2);
  r.api.next = 'completed'; pending.reject(new Error('still offline')); await settle();
  assert.equal(r.api.n, 3);
  r.h.live()[0].fn(); await settle(); assert.equal(r.api.n, 3);
  assert.equal(r.h.timers.length, 1);
});

for (const cleanup of ['unmount', 'route', 'permission', 'support'] as const) {
  test(`#52 ${cleanup} discards queued work and prevents stale success or error writes`, async () => {
    for (const fails of [false, true]) {
      const old = deferred<string>(), current = deferred<string>();
      const r = runHarness(old.promise);
      const tree: any = r.render(); tree.props.onRefresh();
      r.api.next = current.promise;
      if (cleanup === 'unmount') r.h.unmount();
      else {
        if (cleanup === 'route') r.route.runId = 'r2';
        if (cleanup === 'permission') r.rt.me.role = 'member';
        if (cleanup === 'support') r.rt.info.features.routine_history = false;
        r.render();
      }
      const calls = r.api.n, writes = r.h.stats().stateWrites;
      if (fails) old.reject(new Error('old request failed')); else old.resolve('completed');
      await settle();
      assert.equal(r.api.n, calls); assert.equal(r.h.stats().stateWrites, writes);
      if (cleanup === 'unmount') { tree.props.onRefresh(); assert.equal(r.h.live().length, 0); assert.equal(r.api.n, calls); }
      if (cleanup === 'route') {
        current.resolve('running'); await settle();
        r.api.next = 'completed'; r.h.live()[0].fn(); await settle();
        assert.equal(r.api.n, calls + 1); // old completion did not mark the new route finished
      }
    }
  });
}

test('#52 a finished run stops polling, and a manual refresh reloads without restarting the poll clock', async () => {
  const r = runHarness('running');
  r.render(); await settle();
  assert.equal(r.api.n, 1); assert.equal(r.h.live().length, 1); assert.equal(r.h.live()[0].ms, 5000);
  r.h.timers[0].fn(); await settle(); assert.equal(r.api.n, 2); // still running: it polls
  r.api.next = 'completed';
  r.h.timers[0].fn(); await settle(); assert.equal(r.api.n, 3); // this load sees it finish
  r.h.timers[0].fn(); await settle(); assert.equal(r.api.n, 3); // finished: ticks load nothing
  const tree: any = r.render();                                  // refresh used to be an effect dependency
  tree.props.onRefresh(); await settle();
  assert.equal(r.api.n, 4);                                      // the manual refresh did load
  assert.equal(r.h.timers.length, 1);                            // and did not create a new interval
  assert.equal(r.h.live().length, 1);
});
test('#52 the finished flag survives the effect re-running, so a failed reload does not resume polling a finished run', async () => {
  const r = runHarness('completed');
  r.render(); await settle(); assert.equal(r.api.n, 1);
  r.api.next = new Error('offline');                // the bot drops, then comes back and the reload fails
  r.rt.status = 'offline'; r.render(); await settle();
  r.rt.status = 'online'; r.render(); await settle();
  assert.equal(r.h.timers.length, 3);               // the effect re-ran twice
  const calls = r.api.n;                            // each re-run made its one on-start load
  r.h.live()[0].fn(); await settle();
  assert.equal(r.api.n, calls);                     // the run is known finished: the tick loads nothing
});
test('#52 a first load that failed cannot know the run finished, so it keeps retrying (unchanged)', async () => {
  const r = runHarness(new Error('offline'));
  r.render(); await settle(); assert.equal(r.api.n, 1);
  r.api.next = 'completed';
  r.h.live()[0].fn(); await settle(); assert.equal(r.api.n, 2);
  r.h.live()[0].fn(); await settle(); assert.equal(r.api.n, 2);
});

// ---- #44: Server screen focus effect -----------------------------------------------------------------------------------
function serverHarness() {
  const h = hookRuntime();
  const state: any = { servers: [{ id: 'a', url: 'https://one', deviceId: 'd', token: 't1', bot: { title: 'Bot' } }], selection: { serverId: 'a' }, runtime: {} };
  const seen: string[] = [];
  const store = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  const rt: any = { status: 'online', info: { features: {} }, me: { role: 'member' }, conn: { history: [] } };
  const mod = h.load('app/server.tsx', {
    'expo-router': { router: {}, useFocusEffect: (fn: any) => h.effect(fn, [fn]) },
    'react-native': { Text: 'Text', View: 'View' },
    '../lib/store': { useApp: store, useServerState: () => rt, isOwner: () => false },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    '../lib/api': { api: async (s: any, path: string) => { seen.push(`${path} ${s.url} ${s.token}`); return {}; }, ApiError: class extends Error {}, signedApi: async () => ({}) },
    '../lib/motion': { useReducedMotion: () => false, spring: {} },
    '../lib/serverUpdates': { checkServerUpdates: async () => ({}) },
  }, '\nexport { ServerScreen };');
  return { h, state, seen, render: () => h.render(mod.ServerScreen) };
}
test('#44 a store update that leaves the server id and address alone does not restart the Server screen poll', async () => {
  const s = serverHarness();
  s.render(); await settle();
  assert.equal(s.seen.length, 1); assert.equal(s.h.timers.length, 1);
  s.state.servers = [{ ...s.state.servers[0], bot: { title: 'Bot' } }]; // a new server object, same id and address
  s.render(); await settle();
  s.state.servers = [{ ...s.state.servers[0], bot: { title: 'Renamed' } }];
  s.render(); await settle();
  assert.equal(s.seen.length, 1);        // no extra request
  assert.equal(s.h.timers.length, 1);    // the same interval, never restarted
  assert.equal(s.h.live().length, 1);
});
test('#44 the poll still restarts for a different address, and always uses the latest token', async () => {
  const s = serverHarness();
  s.render(); await settle();
  s.state.servers = [{ ...s.state.servers[0], token: 't2' }];
  s.render(); await settle();
  s.h.timers[0].fn(); await settle();
  assert.equal(s.seen.at(-1), '/api/system https://one t2');     // the tick used the new token without a restart
  s.state.servers = [{ ...s.state.servers[0], url: 'https://two' }];
  s.render(); await settle();
  assert.equal(s.seen.at(-1), '/api/system https://two t2');     // a moved address loads straight away
  assert.equal(s.h.timers.length, 2); assert.equal(s.h.live().length, 1);
});
