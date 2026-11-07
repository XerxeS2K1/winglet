import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text } from 'react-native';
import { pushNative } from '../features/encrypted-push/native';
import { useLock } from '../lib/appLock';
import { askAboutBatteryOnce, BATTERY_PROMPT_COPY, BATTERY_PROMPT_KEY } from '../lib/batteryPrompt';
import { getItem, setItem } from '../lib/storage';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import { Sheet, SheetAction } from './Sheet';

/** Winglet's explanation is themed; the battery-exemption dialog that follows belongs to Android. */
export function BatteryPrompt() {
  const t = useTheme();
  const paired = useApp((s) => s.servers.length > 0);
  const locked = useLock((s) => s.locked);
  const foreground = useApp((s) => s.foreground);
  const pathname = usePathname();
  const allowed = Platform.OS === 'android' && paired && !locked && foreground && pathname !== '/pair' && pathname !== '/scan';
  const eligible = useRef(allowed);
  eligible.current = allowed;
  const started = useRef(false);
  const answer = useRef<((value: boolean) => void) | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!allowed || started.current) return;
    let active = true;
    const canAsk = () => active && eligible.current && AppState.currentState === 'active'
      && !useLock.getState().locked && useApp.getState().foreground && useApp.getState().servers.length > 0;
    const finish = (value: boolean) => {
      const resolve = answer.current;
      answer.current = null; // resolve at most once, including stale action/dismiss callbacks
      if (resolve) { setVisible(false); resolve(value && canAsk()); }
    };
    const native = pushNative;
    const timer = setTimeout(() => {
      if (started.current || !canAsk()) return;
      started.current = true;
      void askAboutBatteryOnce({
        android: true,
        native: native && {
          batteryUnrestricted: native.batteryUnrestricted ? () => native.batteryUnrestricted!() : undefined,
          requestBatteryUnrestricted: native.requestBatteryUnrestricted ? () => {
            // Confirm resumes on a microtask: recheck eligibility immediately before crossing into Android.
            if (canAsk()) native.requestBatteryUnrestricted!();
          } : undefined,
        },
        wasAsked: async () => (await getItem(BATTERY_PROMPT_KEY)) === '1',
        markAsked: async () => {
          if (!canAsk()) throw new Error('Battery question no longer eligible');
          await setItem(BATTERY_PROMPT_KEY, '1');
        },
        confirm: () => new Promise<boolean>((resolve) => {
          if (!canAsk()) { resolve(false); return; }
          answer.current = (value) => resolve(value);
          setVisible(true);
        }),
      });
    }, 5000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { finish(false); active = false; }
    });
    // Every exit settles the question. A navigation also cancels the old route's callbacks.
    const cancel = () => { active = false; clearTimeout(timer); finish(false); sub.remove(); };
    return cancel;
  }, [allowed, pathname]);

  const close = (value: boolean) => {
    const resolve = answer.current;
    answer.current = null;
    if (resolve) {
      setVisible(false);
      resolve(value && eligible.current && AppState.currentState === 'active' && !useLock.getState().locked);
    }
  };
  return (
    <Sheet visible={visible && allowed} onClose={() => close(false)} onDismiss={() => close(false)} title={BATTERY_PROMPT_COPY.title} scrollable>
      <Text style={{ ...t.type.callout, color: t.colors.textSecondary, paddingHorizontal: t.space.xs, marginBottom: t.space.md }}>{BATTERY_PROMPT_COPY.message}</Text>
      <SheetAction label={BATTERY_PROMPT_COPY.go} onPress={() => close(true)} />
      <SheetAction label={BATTERY_PROMPT_COPY.later} onPress={() => close(false)} />
    </Sheet>
  );
}
