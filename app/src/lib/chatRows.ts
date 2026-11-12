import { groupActivity, type Entry } from './messages';
import { statusNoticeText } from './statusNotice';
import type { Message } from './types';

/** The rows of the message list, newest first (the list is inverted). */
export type Row =
  | { kind: 'msg'; key: string; m: Message; first: boolean; last: boolean; live: boolean; fresh: boolean; latestReply: boolean }
  | { kind: 'activity'; key: string; items: Message[]; working: boolean }
  | { kind: 'day'; key: string; label: string };

export const GROUP_WINDOW_S = 7 * 60;

/** A local calendar day as a number (20261013), cheap to compare across a whole chat. */
export function dayKey(ts: number) {
  const d = new Date(ts * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function sameGroup(a: Message | undefined, b: Message | undefined) {
  if (!a || !b || a.role !== b.role || a.role === 'system' || b.role === 'system' || statusNoticeText(a) || statusNoticeText(b)) return false;
  return Math.abs(b.created_at - a.created_at) < GROUP_WINDOW_S;
}

export function dayLabel(ts: number, nowMs = Date.now()) {
  const d = new Date(ts * 1000);
  const now = new Date(nowMs);
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function latestReplyId(entries: readonly Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === 'msg' && entry.m.role === 'bot' && !entry.m.meta?.picker && !statusNoticeText(entry.m)) return entry.m.id;
  }
  return undefined;
}

/** The same row, field for field: msg rows by the message object and the flags, activity rows by their messages. */
function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === 'day') return a.label === (b as typeof a).label;
  if (a.kind === 'activity') {
    const c = b as typeof a;
    return a.working === c.working && a.items.length === c.items.length && a.items.every((m, i) => m === c.items[i]);
  }
  const c = b as typeof a;
  return a.m === c.m && a.first === c.first && a.last === c.last && a.live === c.live && a.fresh === c.fresh && a.latestReply === c.latestReply;
}

/**
 * The rows for `messages`. Rows are built exactly as before; then any row equal to the one `previous` had at the same
 * key is handed back as that very object. A streamed token changes one message, so one row comes back new and the rest
 * keep their identity, and the list (which compares rows by identity) leaves them alone.
 */
export function buildRows(
  messages: readonly Message[], typing: boolean, seen: ReadonlySet<string> | null, nowMs: number, previous?: readonly Row[],
): Row[] {
  const out: Row[] = [];
  // Hermes's backend activity (tool calls, status notes) folds into one "…" entry between the replies.
  const entries = groupActivity(messages, typing);
  const latestReply = latestReplyId(entries);
  const idOf = (e: Entry) => (e.kind === 'msg' ? e.m.id : e.id);
  const timeOf = (e: Entry) => (e.kind === 'msg' ? e.m.created_at : e.items[0].created_at);
  const days = entries.map((e) => dayKey(timeOf(e)));
  const labels = new Map<number, string>();
  const dayKeys = new Set<string>();
  let lastSeen = -1;
  if (seen) entries.forEach((e, i) => { if (seen.has(idOf(e))) lastSeen = i; });
  const grouped = (a: Entry | undefined, b: Entry | undefined) => a?.kind === 'msg' && b?.kind === 'msg' && sameGroup(a.m, b.m);
  entries.forEach((e, i) => {
    const day = days[i];
    if (day !== days[i - 1]) {
      let label = labels.get(day);
      if (label === undefined) labels.set(day, (label = dayLabel(timeOf(e), nowMs)));
      // Keyed by the day, so loading older history doesn't remount every separator.
      const key = dayKeys.has(`day-${day}`) ? `day-${day}-${idOf(e)}` : `day-${day}`;
      dayKeys.add(key);
      out.push({ kind: 'day', key, label });
    }
    if (e.kind === 'activity') {
      out.push({ kind: 'activity', key: `activity-${e.id}`, items: e.items, working: typing && i === entries.length - 1 });
      return;
    }
    out.push({
      kind: 'msg', key: e.m.id, m: e.m,
      first: !grouped(entries[i - 1], e) || days[i - 1] !== day,
      last: !grouped(e, entries[i + 1]) || days[i + 1] !== day,
      live: typing && i === entries.length - 1,
      fresh: !!seen && i > lastSeen,
      latestReply: e.m.id === latestReply,
    });
  });
  out.reverse(); // inverted: newest at the bottom without manual scrolling
  if (!previous?.length) return out;
  const before = new Map<string, Row>();
  for (const row of previous) before.set(row.key, row);
  for (let i = 0; i < out.length; i++) {
    const old = before.get(out[i].key);
    if (old && sameRow(old, out[i])) out[i] = old;
  }
  return out;
}
