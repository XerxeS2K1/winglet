import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { pushNative } from '../features/encrypted-push/native';
import { askAboutBatteryOnce, BATTERY_PROMPT_COPY, BATTERY_PROMPT_KEY } from '../lib/batteryPrompt';
import { useLock } from '../lib/appLock';
import { getItem, setItem } from '../lib/storage';
import { useApp } from '../lib/store';

/**
 * Asks, once, to be left out of Android's battery limits. Waits until the phone is paired, unlocked and Winglet is
 * on screen, so it never lands on the lock screen or over the first-run pairing flow.
 */
export function BatteryPrompt() {
  const paired = useApp((s) => s.servers.length > 0);
  const locked = useLock((s) => s.locked);
  const foreground = useApp((s) => s.foreground);
  const pathname = usePathname();
  // Never over the pairing flow, where "paired" turns true a moment before its last step is done.
  const pairing = pathname === '/pair' || pathname === '/scan';
  const started = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android' || !paired || locked || !foreground || pairing || started.current) return;
    const timer = setTimeout(() => {
      if (started.current || AppState.currentState !== 'active' || useLock.getState().locked) return;
      started.current = true;
      void askAboutBatteryOnce({
        android: true,
        native: pushNative,
        wasAsked: async () => (await getItem(BATTERY_PROMPT_KEY)) === '1',
        markAsked: () => setItem(BATTERY_PROMPT_KEY, '1'),
        confirm: () => new Promise<boolean>((resolve) => {
          Alert.alert(BATTERY_PROMPT_COPY.title, BATTERY_PROMPT_COPY.message, [
            { text: BATTERY_PROMPT_COPY.later, style: 'cancel', onPress: () => resolve(false) },
            { text: BATTERY_PROMPT_COPY.go, onPress: () => resolve(true) },
          ], { cancelable: true, onDismiss: () => resolve(false) });
        }),
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [paired, locked, foreground, pairing]);

  return null;
}
