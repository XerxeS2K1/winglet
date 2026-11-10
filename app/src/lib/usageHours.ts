/** Per-hour token usage from GET /api/usage/hours, turned into what the Usage screen draws. */

/** [hour_start_unix, input, output, cache_read, cache_write, calls, cost_cents]. */
export type HourRow = readonly number[];
export type HoursPayload = { from: number; to: number; hours: HourRow[] };

export type HourBar = { hour: number; tokens: number; cents: number; calls: number };

const HOUR = 3600;

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Tokens in the four columns the screen sums: input, output, cache read and cache write. */
export const hourTokens = (r: HourRow) => n(r[1]) + n(r[2]) + n(r[3]) + n(r[4]);

/** Nothing recorded at all: draw "No usage recorded yet" rather than an empty chart. */
export function hasUsage(p: HoursPayload | null | undefined): boolean {
  return !!p && Array.isArray(p.hours) && p.hours.some((r) => hourTokens(r) > 0 || n(r[5]) > 0);
}

/** One bar per hour from the first recorded hour to the last, with silent hours as zero bars.
 *  The server leaves empty hours out, so the gaps are filled here. `max` bounds the bars a phone draws. */
export function hourBars(p: HoursPayload, max = 24 * 7): HourBar[] {
  const rows = (p.hours ?? []).filter((r) => Number.isFinite(r[0])).slice().sort((a, b) => a[0] - b[0]);
  if (!rows.length) return [];
  const byHour = new Map<number, HourRow>(rows.map((r) => [Math.floor(r[0] / HOUR) * HOUR, r]));
  const last = Math.floor(rows[rows.length - 1][0] / HOUR) * HOUR;
  const first = Math.max(Math.floor(rows[0][0] / HOUR) * HOUR, last - (max - 1) * HOUR);
  const out: HourBar[] = [];
  for (let h = first; h <= last; h += HOUR) {
    const r = byHour.get(h);
    out.push({ hour: h, tokens: r ? hourTokens(r) : 0, cents: r ? n(r[6]) : 0, calls: r ? n(r[5]) : 0 });
  }
  return out;
}

/** The calendar day an hour belongs to, as YYYY-MM-DD, for a zone `offsetMinutes` east of UTC. */
export function dayKey(hour: number, offsetMinutes: number): string {
  return new Date((hour + offsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

export const localOffsetMinutes = (hour: number) => -new Date(hour * 1000).getTimezoneOffset();

export type DayTotal = { day: string; tokens: number; cents: number; calls: number };

/** Total tokens, cost and calls for the day that contains `hour`. */
export function dayTotal(bars: HourBar[], hour: number, offsetMinutes = localOffsetMinutes(hour)): DayTotal {
  const day = dayKey(hour, offsetMinutes);
  let tokens = 0, cents = 0, calls = 0;
  for (const b of bars) {
    if (dayKey(b.hour, offsetMinutes) !== day) continue;
    tokens += b.tokens; cents += b.cents; calls += b.calls;
  }
  return { day, tokens, cents, calls };
}

/** Bar heights from 0 to `height`, with a visible stub for any hour that did something. */
export function barHeights(bars: HourBar[], height: number, floor = 2): number[] {
  const top = Math.max(1, ...bars.map((b) => b.tokens));
  return bars.map((b) => (b.tokens > 0 ? Math.max(floor, Math.round((b.tokens / top) * height)) : 0));
}
