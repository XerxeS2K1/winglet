/**
 * Whether the phone has a network, kept separate from Expo so it can be tested.
 *
 * Android's "internet reachable" flag (the network is validated) can read false for a while after deep sleep
 * even though the connection works, and only changes when Android re-checks. So the app only believes
 * "offline" when the phone says it has no connection at all, asks again every few seconds while it thinks it
 * is offline, and asks again the moment the app comes to the front.
 */
export type RawNetwork = { isConnected?: boolean | null; isInternetReachable?: boolean | null };

/** Offline only when the phone reports no connection at all; an unvalidated one still gets tried. */
export function isOnline(state: RawNetwork): boolean {
  return state.isConnected !== false;
}

export const OFFLINE_POLL_MS = 3000;

export type NetworkDeps = {
  read: () => Promise<RawNetwork>;
  subscribe: (cb: (state: RawNetwork) => void) => () => void;
  /** Called when the app comes to the front. */
  onForeground: (cb: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  pollMs?: number;
};

export type NetworkWatch = { stop: () => void; refresh: () => Promise<void> };

export function watchPhoneNetwork(deps: NetworkDeps, onChange: (online: boolean) => void): NetworkWatch {
  let online = true;
  let stopped = false;
  let timer: unknown;

  const apply = (state: RawNetwork) => {
    if (stopped) return;
    online = isOnline(state);
    onChange(online);
    if (!online && timer === undefined) timer = deps.setInterval(() => { void refresh(); }, deps.pollMs ?? OFFLINE_POLL_MS);
    if (online && timer !== undefined) { deps.clearInterval(timer); timer = undefined; }
  };
  const refresh = async () => {
    try { apply(await deps.read()); } catch { /* keep the last answer; the next poll asks again */ }
  };

  void refresh();
  const unsubscribe = deps.subscribe(apply);
  const offForeground = deps.onForeground(() => { void refresh(); });
  return {
    refresh,
    stop() {
      stopped = true;
      unsubscribe();
      offForeground();
      if (timer !== undefined) deps.clearInterval(timer);
      timer = undefined;
    },
  };
}
