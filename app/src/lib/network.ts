import { AppState, Platform } from 'react-native';
import * as Network from 'expo-network';
import { watchPhoneNetwork, type NetworkWatch } from './networkState';

let current: NetworkWatch | undefined;

/** Ask the phone about its network again now (the "Try now" button uses this). */
export function refreshNetworkNow(): Promise<void> {
  return current?.refresh() ?? Promise.resolve();
}

/** Whether the phone has a network at all. "No internet" and "server unreachable" need different help. */
export function watchNetwork(onChange: (online: boolean) => void): () => void {
  if (Platform.OS === 'web') {
    const on = () => onChange(true);
    const off = () => onChange(false);
    globalThis.addEventListener?.('online', on);
    globalThis.addEventListener?.('offline', off);
    if (globalThis.navigator?.onLine === false) onChange(false);
    return () => {
      globalThis.removeEventListener?.('online', on);
      globalThis.removeEventListener?.('offline', off);
    };
  }
  const watch = watchPhoneNetwork({
    read: () => Network.getNetworkStateAsync(),
    subscribe: (cb) => {
      const sub = Network.addNetworkStateListener(cb);
      return () => sub.remove();
    },
    onForeground: (cb) => {
      const sub = AppState.addEventListener('change', (s: string) => { if (s === 'active') cb(); });
      return () => sub.remove();
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  }, onChange);
  current = watch;
  return () => { watch.stop(); if (current === watch) current = undefined; };
}
