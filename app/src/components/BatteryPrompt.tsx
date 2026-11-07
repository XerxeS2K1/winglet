import { Alert, AppState, Platform, type AppStateStatus } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'expo-router';
import { useLock } from '../lib/appLock';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import { Sheet, SheetAction } from './Sheet';
import { Text } from 'react-native';
import { getItem, setItem } from '../lib/storage';
import { BATTERY_PROMPT_COPY, BATTERY_PROMPT_KEY, askAboutBatteryOnce, type BatteryDeps } from '../lib/batteryPrompt';
import { pushNative } from '../features/encrypted-push/native';

const DEFER_MS = 5000;
const ELIGIBLE_PATHS = new Set(['/', '/chats', '/devices', '/settings', '/activity']);

export function BatteryPrompt() {
  const t = useTheme();
  const lock = useLock((s) => s.locked);
  const paired = useApp((s) => s.servers.length > 0);
  const foreground = useApp((s) => s.foreground ?? true);
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const settledRef = useRef(false);
  const generation = useRef(0);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const allowed = !lock && paired && foreground && ELIGIBLE_PATHS.has(path);
  const eligibleRef = useRef(allowed);
  eligibleRef.current = allowed;

  useEffect(() => {
    if (!allowed || open || resolveRef.current || settledRef.current) return;
    const current = ++generation.current;
    let active = true;
    const deps: BatteryDeps = {
      android: Platform.OS === 'android',
      native: pushNative,
      wasAsked: async () => (await getItem(BATTERY_PROMPT_KEY)) === '1',
      markAsked: async () => { await setItem(BATTERY_PROMPT_KEY, '1'); },
      confirm: async () => new Promise((resolve) => {
        resolveRef.current = resolve;
        setOpen(true);
      }),
    };
    const run = async () => {
      try { await askAboutBatteryOnce(deps); }
      finally { if (active && current === generation.current) { resolveRef.current = null; settledRef.current = true; } }
    };
    run();
    const timer = setTimeout(() => { if (active && current === generation.current) setOpen(true); }, DEFER_MS);
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active' && active && current === generation.current) {
        setOpen(false);
        active = false;
        resolveRef.current?.(false);
        resolveRef.current = null;
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
      sub.remove();
      setOpen(false);
      resolveRef.current?.(false);
      resolveRef.current = null;
      generation.current++;
    };
  }, [allowed]);

  const close = (value: boolean) => {
    setOpen(false);
    if (!eligibleRef.current || AppState.currentState !== 'active' || settledRef.current) value = false;
    settledRef.current = true;
    resolveRef.current?.(value);
    resolveRef.current = null;
  };

  if (!allowed) return null;
  return (
    <Sheet visible={open} onClose={() => close(false)} onDismiss={() => close(false)} title={BATTERY_PROMPT_COPY.title} scrollable>
      <Text style={{ color: t.colors.textSecondary }}>{BATTERY_PROMPT_COPY.message}</Text>
      <SheetAction label={BATTERY_PROMPT_COPY.go} onPress={() => close(true)} />
      <SheetAction label={BATTERY_PROMPT_COPY.later} onPress={() => close(false)} />
    </Sheet>
  );
}
