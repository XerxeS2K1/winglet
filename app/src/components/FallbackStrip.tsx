import { useEffect, useState } from 'react';
import { Keyboard, Platform, Text, View, useWindowDimensions } from 'react-native';
import { isTicking, monotonicNow, stripLines, stripText, type FallbackSnapshot } from '../lib/fallbackNotice';
import { openModelSheet, useFallback } from '../lib/fallbackStore';
import { alpha } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { Tap } from './ui';

/**
 * "Fallback · rate limit  1 h 52 min" above the message box while the agent is on a fallback model. It shows what the
 * model button already fetched (nothing is asked of the server here) and disappears the moment the fallback does, with
 * no message of its own about being back on the main model. Tapping it opens the model sheet, like the chip.
 */
export function FallbackStrip({ server, chatId }: { server: Server; chatId: string }) {
  const key = `${server.id}:${chatId}`;
  const snapshot = useFallback((st) => st.slots[key]);
  return snapshot ? <Strip snapshot={snapshot} chatKey={key} /> : null;
}

function Strip({ snapshot, chatKey }: { snapshot: FallbackSnapshot; chatKey: string }) {
  const t = useTheme();
  const s = useStyles();
  const [now, setNow] = useState(monotonicNow);
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardOpen();

  // One tick a second while the countdown is still running; none once it reads "next message".
  useEffect(() => {
    setNow(monotonicNow());
    if (!isTicking(snapshot, monotonicNow())) return undefined;
    const timer = setInterval(() => {
      const at = monotonicNow();
      setNow(at);
      if (!isTicking(snapshot, at)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

  const text = stripText(snapshot, now);
  if (!text) return null;
  // With no countdown there is room for the line that says what happens next, keyboard or not.
  const showDetail = (stripLines(keyboard, height) === 2 || !text.countdown) && !!text.detail;
  const label = [text.title, text.countdown, showDetail ? text.detail : null].filter(Boolean).join(', ');
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={() => openModelSheet(chatKey)}
      accessibilityLabel={`${label}. Change the model`}
      style={[s.strip, { borderColor: alpha(t.colors.warning, 0.4) }]}>
      <View style={s.line}>
        <Text style={s.reason} numberOfLines={1}>{text.title}</Text>
        {text.countdown ? <Text style={s.countdown} numberOfLines={1}>{text.countdown}</Text> : null}
      </View>
      {showDetail ? <Text style={s.detail} numberOfLines={1} ellipsizeMode="tail">{text.detail}</Text> : null}
    </Tap>
  );
}

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(() => Platform.OS !== 'web' && (Keyboard.metrics?.()?.height ?? 0) > 0);
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true));
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return open;
}

const useStyles = makeStyles((t) => ({
  // No fixed heights: the strip grows with the font-size setting.
  strip: { marginHorizontal: 10, marginTop: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, gap: 1,
    backgroundColor: t.colors.warningSoft },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  // The reason may be cut with "…"; the countdown never is.
  reason: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.warning, flexShrink: 1 },
  countdown: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.warning, flexShrink: 0 },
  detail: { ...t.type.caption, color: t.colors.textSecondary },
}));
