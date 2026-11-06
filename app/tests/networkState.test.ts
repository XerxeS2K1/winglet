import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOnline, watchPhoneNetwork, OFFLINE_POLL_MS, type RawNetwork } from '../src/lib/networkState.ts';

/** A phone whose network answers are scripted, with a hand-turned clock instead of real timers. */
function phone(initial: RawNetwork) {
  const calls = { reads: 0 };
  let state = initial;
  let listener: ((s: RawNetwork) => void) | undefined;
  let foreground: (() => void) | undefined;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const deps = {
    read: async () => { calls.reads += 1; return state; },
    subscribe: (cb: (s: RawNetwork) => void) => { listener = cb; return () => { listener = undefined; }; },
    onForeground: (cb: () => void) => { foreground = cb; return () => { foreground = undefined; }; },
    setInterval: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id: unknown) => { timers.delete(id as number); },
  };
  return {
    deps, calls, timers,
    set: (s: RawNetwork) => { state = s; },
    emit: (s: RawNetwork) => listener?.(s),
    wake: () => foreground?.(),
    tick: () => { for (const t of [...timers.values()]) t.fn(); },
  };
}
const settle = () => new Promise((r) => setImmediate(r));

test('only "no connection at all" counts as offline; an unvalidated one is still tried', () => {
  assert.equal(isOnline({ isConnected: false, isInternetReachable: false }), false);
  assert.equal(isOnline({ isConnected: true, isInternetReachable: false }), true);
  assert.equal(isOnline({ isConnected: true, isInternetReachable: true }), true);
  assert.equal(isOnline({}), true);
});

test('the stale "not validated" answer after deep sleep no longer shows No internet', async () => {
  const p = phone({ isConnected: true, isInternetReachable: false });
  const seen: boolean[] = [];
  const w = watchPhoneNetwork(p.deps, (o) => seen.push(o));
  await settle();
  assert.deepEqual(seen, [true]);
  assert.equal(p.timers.size, 0);
  w.stop();
});

test('while offline it asks the phone again every few seconds, and stops once online', async () => {
  const p = phone({ isConnected: false });
  const seen: boolean[] = [];
  const w = watchPhoneNetwork(p.deps, (o) => seen.push(o));
  await settle();
  assert.deepEqual(seen, [false]);
  assert.equal(p.timers.size, 1);
  assert.equal([...p.timers.values()][0].ms, OFFLINE_POLL_MS);
  const before = p.calls.reads;
  p.tick(); await settle();
  assert.equal(p.calls.reads, before + 1);
  assert.deepEqual(seen, [false, false]);
  p.set({ isConnected: true }); // Android never sent a change event, but the next poll sees it
  p.tick(); await settle();
  assert.deepEqual(seen, [false, false, true]);
  assert.equal(p.timers.size, 0);
  w.stop();
});

test('opening the app asks again at once, without waiting for the poll', async () => {
  const p = phone({ isConnected: false });
  const seen: boolean[] = [];
  const w = watchPhoneNetwork(p.deps, (o) => seen.push(o));
  await settle();
  p.set({ isConnected: true });
  p.wake(); await settle();
  assert.equal(seen.at(-1), true);
  w.stop();
});

test('"Try now" can ask on demand, and a failed read keeps the last answer', async () => {
  const p = phone({ isConnected: false });
  const seen: boolean[] = [];
  const w = watchPhoneNetwork({ ...p.deps, read: async () => { if (seen.length > 1) throw new Error('boom'); return { isConnected: false }; } },
    (o) => seen.push(o));
  await settle();
  await w.refresh();
  await w.refresh(); // throws inside, is swallowed
  assert.deepEqual(seen, [false, false]);
  w.stop();
});

test('stopping cancels the poll and the listeners', async () => {
  const p = phone({ isConnected: false });
  const w = watchPhoneNetwork(p.deps, () => undefined);
  await settle();
  w.stop();
  assert.equal(p.timers.size, 0);
  p.emit({ isConnected: true }); // no listener left; nothing should throw
  p.wake();
});
