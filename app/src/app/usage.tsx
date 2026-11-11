import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Coins, MessagesSquare, Zap } from '../components/icons';
import { shortModel } from '../components/PickerCard';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Card, Footnote, ListGroup, ListRow, LoadError, SectionHeader, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatCost, type Currency } from '../lib/currency';
import { usePrefs } from '../lib/prefs';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { alpha } from '../lib/theme';
import { barHeights, dayTotal, hasUsage, hourBars, type HoursPayload } from '../lib/usageHours';
import { makeStyles, useTheme } from '../lib/themeContext';

type Row = { input_tokens?: number; output_tokens?: number; estimated_cost?: number; sessions?: number };
type Usage = {
  daily: (Row & { day: string })[];
  by_model: (Row & { model: string })[];
  totals: { total_input?: number; total_output?: number; total_estimated_cost?: number; total_actual_cost?: number; total_sessions?: number };
  period_days: number;
  /** Pounds per dollar, from the server's daily rate. Absent on an older server or before a rate is fetched. */
  usd_gbp?: number;
};

const compact = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
/** Shows a cost (given in dollars) as text; the screen passes one in the chosen currency, tests and old callers get dollars. */
type Money = (usd: number) => string;
const dollars: Money = (n) => formatCost(n, 'usd');
const tokens = (r: Row) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
const rise = (reduced: boolean, i: number) => (reduced ? undefined
  : FadeIn.duration(180));

/** Tokens and estimated cost, per day and per model, from Hermes's own session records. */
export default withSelectedServer(UsageScreen);

function UsageScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const currency = usePrefs((st) => st.prefs.currency);
  const setCurrency = usePrefs((st) => st.update);
  // Each period's figures, kept: switching back shows them at once while they refresh.
  const [byDays, setByDays] = useState<Record<string, Usage>>({});
  const [error, setError] = useState('');
  const data = byDays[days] ?? null;
  // Per-hour figures are always the last 7 days. A server without the route just has no hourly section.
  const [hours, setHours] = useState<HoursPayload | null>(null);

  const load = () => {
    if (!server) return;
    const period = days;
    api<HoursPayload>(server, '/api/usage/hours?days=7').then(setHours).catch(() => setHours(null));
    return api<Usage>(server, `/api/usage?days=${period}`)
      .then((d) => { setByDays((all) => ({ ...all, [period]: d })); setError(''); })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { setError(''); load(); }, [server?.id, days]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalTokens = (data?.totals.total_input ?? 0) + (data?.totals.total_output ?? 0);
  const cost = data?.totals.total_actual_cost || data?.totals.total_estimated_cost || 0;
  const money: Money = (usd) => formatCost(usd, currency, data?.usd_gbp);
  return (
    <Screen title="Usage" onRefresh={load}>
      <View style={s.controls}>
        <View style={{ flex: 1 }}>
          <Segmented label="Period" value={days} onChange={setDays}
            options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        </View>
        <View style={{ width: 104 }}>
          <Segmented label="Currency" value={currency} onChange={(c: Currency) => setCurrency({ currency: c })}
            options={[{ value: 'gbp', label: '£' }, { value: 'usd', label: '$' }]} />
        </View>
      </View>
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} />
        : <View style={{ gap: 12, marginTop: 16 }}><Skeleton height={140} radius={t.radius.lg} /><Skeleton height={220} radius={t.radius.lg} /></View>) : (
        <>
          <Animated.View entering={rise(reduced, 0)} style={s.tiles}>
            <Stat label="Tokens" value={compact(totalTokens)} />
            <View style={s.divider} />
            <Stat label="Est. cost" value={money(cost)} />
            <View style={s.divider} />
            <Stat label="Sessions" value={String(data.totals.total_sessions ?? 0)} />
          </Animated.View>
          <Footnote>Costs use public prices and may differ from your bill.</Footnote>
          {hours ? (
            <Animated.View entering={rise(reduced, 1)}>
              <SectionHeader title="Tokens per hour" />
              <HourlyBars payload={hours} money={money} />
            </Animated.View>
          ) : null}
          <Animated.View entering={rise(reduced, 1)}>
            <SectionHeader title="Tokens per day" />
            <DailyBars rows={data.daily} money={money} />
          </Animated.View>
          <Animated.View entering={rise(reduced, 2)}>
            <SectionHeader title="By model" />
            <Models rows={data.by_model} money={money} />
          </Animated.View>
        </>
      )}
    </Screen>
  );
}

/** One number with its label, a column of the summary. */
function Stat({ label, value }: { label: string; value: string }) {
  const s = useStyles();
  return (
    <View style={s.tile} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={s.tileLabel} numberOfLines={1}>{label}</Text>
      <Text style={s.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

/**
 * One series, one hue: a bar per day, tap one for its numbers. The pick is a day, not a position: switching
 * period keeps it when that day is in the new one, and shows the latest day when it isn't.
 */
export function DailyBars({ rows, money = dollars }: { rows: Usage['daily']; money?: Money }) {
  const t = useTheme();
  const s = useStyles();
  const [day, setDay] = useState<string | null>(null);
  if (!rows.length) return <Card><Text style={s.empty}>No sessions in this period.</Text></Card>;
  const max = Math.max(1, ...rows.map(tokens));
  const chosen = day === null ? undefined : rows.find((r) => r.day === day);
  const picked = chosen ? rows.indexOf(chosen) : null;
  const shown = chosen ?? rows[rows.length - 1];
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <Card style={{ gap: 14 }}>
      <View style={s.readout} accessibilityLiveRegion="polite">
        <Text style={s.readoutDay}>{label(shown.day)}{picked === null ? ' (latest)' : ''}</Text>
        <View style={s.modelHead}>
          <Text style={s.readoutValue}>{compact(tokens(shown))} tokens</Text>
          <Text style={s.modelValue}>{money(shown.estimated_cost ?? 0)}</Text>
        </View>
      </View>
      <View style={s.plot}>
        <View style={s.grid} />
        <View style={s.bars}>
          {rows.map((r, i) => {
            const h = Math.max(2, (tokens(r) / max) * 140);
            const on = picked === i;
            return (
              <Pressable key={r.day} onPress={() => setDay(on ? null : r.day)} style={s.hit} hitSlop={4}
                accessibilityRole="button" accessibilityLabel={`${label(r.day)}: ${compact(tokens(r))} tokens, ${money(r.estimated_cost ?? 0)}`}>
                <View style={[s.bar, { height: h, backgroundColor: t.colors.accent, opacity: picked === null || on ? 1 : 0.3 }]} />
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={s.axis}>
        <Text style={s.axisText}>{label(rows[0].day)}</Text>
        <Text style={s.axisText}>{label(rows[rows.length - 1].day)}</Text>
      </View>
    </Card>
  );
}

/**
 * The last seven days, one thin bar per hour (input, output and cache tokens together). Tap an hour to see it;
 * the day's total and cost sit under the chart. An hour's tokens are counted when its session last wrote, so a
 * long session shows up at its end rather than spread across the hours it ran.
 */
export function HourlyBars({ payload, money = dollars }: { payload: HoursPayload; money?: Money }) {
  const t = useTheme();
  const s = useStyles();
  const [picked, setPicked] = useState<number | null>(null);
  if (!hasUsage(payload)) return <Card><Text style={s.empty}>No usage recorded yet</Text></Card>;
  const bars = hourBars(payload);
  const heights = barHeights(bars, 140);
  const chosen = picked === null ? undefined : bars.find((b) => b.hour === picked);
  const shown = chosen ?? bars[bars.length - 1];
  const day = dayTotal(bars, shown.hour);
  const when = (h: number) => new Date(h * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric' });
  const dayLabel = new Date(`${day.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <Card style={{ gap: 14 }}>
      <View style={s.readout} accessibilityLiveRegion="polite">
        <Text style={s.readoutDay}>{when(shown.hour)}{chosen ? '' : ' (latest hour)'}</Text>
        <View style={s.modelHead}>
          <Text style={s.readoutValue}>{compact(shown.tokens)} tokens</Text>
          <Text style={s.modelValue}>{money(shown.cents / 100)}</Text>
        </View>
      </View>
      <View style={s.plot}>
        <View style={s.grid} />
        <View style={[s.bars, { gap: 1 }]}>
          {bars.map((b, i) => (
            <Pressable key={b.hour} onPress={() => setPicked(b.hour === picked ? null : b.hour)} style={s.hit} hitSlop={2}
              accessibilityRole="button" accessibilityLabel={`${when(b.hour)}: ${compact(b.tokens)} tokens, ${money(b.cents / 100)}`}>
              <View style={[s.bar, { minWidth: 1, height: heights[i], backgroundColor: t.colors.accent,
                opacity: chosen && b.hour !== chosen.hour ? 0.3 : 1 }]} />
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.modelHead} accessible accessibilityLabel={`${dayLabel}: ${compact(day.tokens)} tokens, ${money(day.cents / 100)}`}>
        <Text style={s.empty}>{dayLabel} total</Text>
        <Text style={s.modelValue}>{compact(day.tokens)} tokens · {money(day.cents / 100)}</Text>
      </View>
    </Card>
  );
}

function Models({ rows, money }: { rows: Usage['by_model']; money: Money }) {
  const s = useStyles();
  return (
    <ListGroup>
      {rows.length ? rows.slice(0, 12).map((r) => (
        <ListRow key={r.model} title={shortModel(r.model)} value={`${compact(tokens(r))} tokens`}
          right={<Text style={s.modelValue}>{money(r.estimated_cost ?? 0)}</Text>} />
      )) : <ListRow title="No model usage yet." />}
    </ListGroup>
  );
}

const useStyles = makeStyles((t) => ({
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  empty: { ...t.type.callout, color: t.colors.textSecondary },
  tiles: {
    flexDirection: 'row', marginTop: t.space.lg, paddingVertical: t.space.lg, backgroundColor: t.colors.surface,
    borderColor: t.colors.border, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: t.radius.lg,
  },
  divider: { width: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border },
  tile: { flex: 1, minWidth: 0, gap: 4, paddingHorizontal: t.space.lg },
  tileValue: { ...t.type.title, fontSize: 22, color: t.colors.text, fontVariant: ['tabular-nums'] },
  tileLabel: { ...t.type.footnote, color: t.colors.textSecondary },
  readout: { gap: 2 },
  readoutDay: { ...t.type.caption, color: t.colors.textSecondary },
  readoutValue: { ...t.type.title, color: t.colors.text, fontVariant: ['tabular-nums'] },
  plot: { height: 148, justifyContent: 'flex-end' },
  grid: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 148 },
  hit: { flex: 1, height: 148, justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '100%', maxWidth: 16, minWidth: 2, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { ...t.type.caption, color: t.colors.textTertiary },
  modelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  modelValue: { ...t.type.callout, color: t.colors.textSecondary },
}));
