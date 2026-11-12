import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function compile(file: string, imports: Record<string, any> = {}) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (id: string) => { if (id in imports) return imports[id]; throw new Error(`Unexpected import ${id}`); }, Date, Map, Set });
  return exports;
}
const messages = compile('../src/lib/messages.ts');
const notice = compile('../src/lib/statusNotice.ts');
const { buildRows, dayKey } = compile('../src/lib/chatRows.ts', { './messages': messages, './statusNotice': notice });

/**
 * The row builder exactly as ChatView.tsx's MessageList had it before it moved to lib/chatRows.ts (taken from git, only the
 * names of its inputs changed). buildRows without `previous` must give the same rows, field for field.
 */
function referenceRows(list: any[], typing: boolean, seen: Set<string> | null, nowMs: number) {
  const GROUP_WINDOW_S = 7 * 60;
  const { groupActivity } = messages;
  const { statusNoticeText } = notice;
  const latestReplyId = (entries: any[]) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === 'msg' && entry.m.role === 'bot' && !entry.m.meta?.picker && !statusNoticeText(entry.m)) return entry.m.id;
    }
    return undefined;
  };
  const sameGroup = (a: any, b: any) => {
    if (!a || !b || a.role !== b.role || a.role === 'system' || b.role === 'system' || statusNoticeText(a) || statusNoticeText(b)) return false;
    return Math.abs(b.created_at - a.created_at) < GROUP_WINDOW_S;
  };
  const dayLabel = (t: number) => {
    const d = new Date(t * 1000);
    const now = new Date(nowMs);
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  };
  const out: any[] = [];
  const entries = groupActivity(list, typing);
  const latestReply = latestReplyId(entries);
  const idOf = (e: any) => (e.kind === 'msg' ? e.m.id : e.id);
  const timeOf = (e: any) => (e.kind === 'msg' ? e.m.created_at : e.items[0].created_at);
  const days = entries.map((e: any) => dayKey(timeOf(e)));
  const labels = new Map<number, string>();
  const dayKeys = new Set<string>();
  let lastSeen = -1;
  if (seen) entries.forEach((e: any, i: number) => { if (seen.has(idOf(e))) lastSeen = i; });
  const grouped = (a: any, b: any) => a?.kind === 'msg' && b?.kind === 'msg' && sameGroup(a.m, b.m);
  entries.forEach((e: any, i: number) => {
    const day = days[i];
    if (day !== days[i - 1]) {
      let label = labels.get(day);
      if (label === undefined) labels.set(day, (label = dayLabel(timeOf(e))));
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
  return out.reverse();
}

/** The module runs in its own vm context, so arrays and objects are copied before assert.deepEqual compares them. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAY = 86400;
const base = Math.floor(NOW / 1000) - 3 * DAY;
let n = 0;
const msg = (over: Record<string, unknown> = {}) => {
  n++;
  return { id: `m${n}`, chat_id: 'c', role: 'bot', text: `text ${n}`, status: 'final', meta: {}, created_at: base + n * 100, updated_at: base + n * 100, ...over };
};
/** A varied chat: user and bot turns, groups, day changes, folded activity, status notices, a picker, a streaming tail. */
function chat(size: number) {
  const list: any[] = [];
  let t = base;
  for (let i = 0; i < size; i++) {
    t += i % 11 === 0 ? 5 * 3600 : i % 5 === 0 ? 900 : 60;       // sometimes a long gap, sometimes a new day
    const kind = i % 7;
    list.push(msg({
      id: `h${i}`, created_at: t, updated_at: t,
      role: kind === 0 || kind === 3 ? 'user' : 'bot',
      text: kind === 2 ? '⏳ Still working on it' : kind === 4 ? 'Reading the file…' : `message ${i}`,
      meta: kind === 4 ? { activity: true } : kind === 5 && i % 2 ? { picker: { kind: 'model' } } : {},
    }));
  }
  return list;
}

test('buildRows gives the rows the list always had (same fields, same order), for many shapes of chat', () => {
  for (const size of [0, 1, 2, 5, 40, 120]) {
    for (const typing of [false, true]) {
      const list = chat(size);
      for (const seen of [null, new Set(list.slice(0, Math.floor(size / 2)).map((m) => m.id))]) {
        assert.deepEqual(plain(buildRows(list, typing, seen, NOW)), plain(referenceRows(list, typing, seen, NOW)), `${size} messages, typing ${typing}, seen ${seen ? 'half' : 'none'}`);
      }
    }
  }
  const tail = [...chat(30), msg({ text: 'so far', status: 'streaming' })];
  assert.deepEqual(plain(buildRows(tail, true, null, NOW)), plain(referenceRows(tail, true, null, NOW)));
});

test('with the previous rows given the rows are still equal field for field (only their identity is reused)', () => {
  const list = chat(80);
  const first = buildRows(list, false, new Set(), NOW);
  const grown = [...list, msg({ text: 'a question', role: 'user' })];
  assert.deepEqual(plain(buildRows(grown, false, new Set(), NOW, first)), plain(referenceRows(grown, false, new Set(), NOW)));
});

test('a streamed token changes one row object and leaves every other row the same object', () => {
  const history = chat(120);
  const seen = new Set(history.map((m) => m.id));
  const live = msg({ id: 'live', text: 'The', status: 'streaming', created_at: base + 9 * DAY });
  let rows = buildRows([...history, live], true, seen, NOW);
  for (const text of ['The quick', 'The quick brown', 'The quick brown fox']) {
    const next = buildRows([...history, { ...live, text, updated_at: live.updated_at + 1 }], true, seen, NOW, rows);
    assert.equal(next.length, rows.length);
    const changed = next.filter((r: any, i: number) => r !== rows[i]);
    assert.deepEqual(plain(changed.map((r: any) => r.key)), ['live'], 'only the streaming row is a new object');
    assert.equal(changed[0].m.text, text);
    rows = next;
  }
});

test('a row whose look changed is a new object: neighbours of a new message, a finished reply, a day change, typing ending', () => {
  const history = chat(20);
  const live = msg({ id: 'live', text: 'so far', status: 'streaming', created_at: history[history.length - 1].created_at + 10 });
  const a = buildRows([...history, live], true, null, NOW);
  const byKey = (rows: any[], key: string) => rows.find((r: any) => r.key === key);

  // The streaming reply finishes and typing ends: `live` flag of its row changes.
  const done = { ...live, status: 'final', text: 'all done', updated_at: live.updated_at + 1 };
  const b = buildRows([...history, done], false, null, NOW, a);
  assert.notEqual(byKey(b, 'live'), byKey(a, 'live'));
  assert.equal(byKey(b, 'live').live, false);

  // A new message from the same sender joins its group: the one before it is no longer the last of the group.
  const follow = msg({ id: 'follow', created_at: done.created_at + 5, role: 'bot', text: 'one more thing' });
  const c = buildRows([...history, done, follow], false, null, NOW, b);
  assert.equal(byKey(c, 'live').last, false, 'no longer the last of its group');
  assert.notEqual(byKey(c, 'live'), byKey(b, 'live'));
  assert.equal(byKey(c, 'follow').last, true);

  // A message from the user closes the group again.
  const ask = msg({ id: 'ask', created_at: follow.created_at + 5, role: 'user', text: 'and?' });
  const d = buildRows([...history, done, follow, ask], false, null, NOW, c);
  assert.equal(byKey(d, 'follow').last, true);
  assert.equal(byKey(d, 'follow'), byKey(c, 'follow'), 'a row that did not change keeps its identity');

  // A reply of a different day gets a day chip.
  const nextDay = msg({ id: 'tomorrow', created_at: ask.created_at + 2 * DAY, role: 'bot', text: 'next day' });
  const e = buildRows([...history, done, follow, ask, nextDay], false, null, NOW, d);
  assert.ok(e.some((r: any) => r.kind === 'day' && r.key.includes('-tomorrow') === false) && e.length === d.length + 2, 'a message and a day chip');
});

test('a message that changes while it is not the last one (an edit, a late update) is a new row; others stay', () => {
  const list = chat(50);
  const rows = buildRows(list, false, null, NOW);
  const edited = list.slice();
  edited[10] = { ...edited[10], text: 'edited later', updated_at: edited[10].updated_at + 9 };
  const next = buildRows(edited, false, null, NOW, rows);
  const changed = next.filter((r: any, i: number) => r !== rows[i]).map((r: any) => r.key);
  assert.deepEqual(plain(changed), [edited[10].id]);
});

test('rows of a folded run of activity keep their identity until a message in the run changes', () => {
  const list = [msg({ role: 'user', text: 'do it' }), msg({ text: 'Reading…', meta: { activity: true } }), msg({ text: 'Searching…', meta: { activity: true } })];
  const a = buildRows(list, true, null, NOW);
  const same = buildRows(list.slice(), true, null, NOW, a);
  assert.ok(same.every((r: any, i: number) => r === a[i]));
  const more = [...list, msg({ text: 'Writing…', meta: { activity: true } })];
  const grown = buildRows(more, true, null, NOW, a);
  const activityRow = (rows: any[]) => rows.find((r: any) => r.kind === 'activity');
  assert.notEqual(activityRow(grown), activityRow(a));
  assert.equal(activityRow(grown).items.length, 3);
});

test('rows are keyed by message id; a key that appears twice does not confuse the reuse', () => {
  const list = chat(6);
  const rows = buildRows(list, false, null, NOW);
  const swapped = [list[1], list[0], ...list.slice(2)];
  assert.deepEqual(plain(buildRows(swapped, false, null, NOW, rows)), plain(referenceRows(swapped, false, null, NOW)));
});

test('the list gets one renderItem function, not a new one per render (a cell only skips its redraw if its props are equal)', () => {
  const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
  assert.match(source, /const renderItem = useCallback\(/);
  assert.match(source, /renderItem=\{renderItem\}/);
  assert.equal(/renderItem=\{\(/.test(source), false, 'no inline renderItem arrow');
  assert.match(source, /buildRows\(messages, typing, seen\.current, Date\.now\(\), lastRows\.current\)/, 'the rows are built with the previous rows');
});

test('each look flag on its own makes a new row object: group end, typing, unseen, latest reply, day label', () => {
  const t0 = base + 10 * DAY;
  const byKey = (rows: any[], key: string) => rows.find((r: any) => r.key === key);
  const only = (before: any[], after: any[], keys: string[]) => assert.deepEqual(plain(after.filter((r: any, i: number) => r !== before[i]).map((r: any) => r.key)), keys);

  // group end: a second message from the user right after the first (bot rows and latest-reply untouched)
  const u1 = msg({ id: 'u1', role: 'user', created_at: t0 });
  const u2 = msg({ id: 'u2', role: 'user', created_at: t0 + 30 });
  const a = buildRows([u1], false, null, NOW);
  const b = buildRows([u1, u2], false, null, NOW, a);
  assert.equal(byKey(a, 'u1').last, true);
  assert.equal(byKey(b, 'u1').last, false);
  assert.equal(byKey(b, 'u2').first, false);
  assert.equal(byKey(b, 'u1').m, byKey(a, 'u1').m);
  assert.notEqual(byKey(b, 'u1'), byKey(a, 'u1'), 'the first message of a group is redrawn when the group grows');

  // typing: the same messages, the "…" indicator turns off
  const x = msg({ id: 'x', role: 'user', created_at: t0 });
  const typingOn = buildRows([x], true, null, NOW);
  const typingOff = buildRows([x], false, null, NOW, typingOn);
  assert.equal(byKey(typingOn, 'x').live, true);
  assert.equal(byKey(typingOff, 'x').live, false);
  assert.notEqual(byKey(typingOff, 'x'), byKey(typingOn, 'x'));

  // unseen: the same messages, the "already seen" set grows
  const m1 = msg({ id: 'seen1', role: 'user', created_at: t0 }), m2 = msg({ id: 'seen2', role: 'user', created_at: t0 + 2000 });
  const unseen = buildRows([m1, m2], false, new Set(['seen1']), NOW);
  const allSeen = buildRows([m1, m2], false, new Set(['seen1', 'seen2']), NOW, unseen);
  assert.equal(byKey(unseen, 'seen2').fresh, true);
  assert.equal(byKey(allSeen, 'seen2').fresh, false);
  only(unseen, allSeen, ['seen2']);

  // latest reply: a newer bot reply far from the older one (not grouped): only the older row's flag changes
  const r1 = msg({ id: 'r1', created_at: t0 }), r2 = msg({ id: 'r2', created_at: t0 + 3600 });
  const one = buildRows([r1], false, null, NOW);
  const two = buildRows([r1, r2], false, null, NOW, one);
  assert.equal(byKey(one, 'r1').latestReply, true);
  assert.equal(byKey(two, 'r1').latestReply, false);
  assert.notEqual(byKey(two, 'r1'), byKey(one, 'r1'));

  // day label: the same message, but it is now a day later ("Today" becomes "Yesterday")
  const d1 = msg({ id: 'd1', created_at: Math.floor(NOW / 1000) - 600 });
  const today = buildRows([d1], false, null, NOW);
  const later = buildRows([d1], false, null, NOW + DAY * 1000, today);
  const label = (rows: any[]) => rows.find((r: any) => r.kind === 'day').label;
  assert.equal(label(today), 'Today');
  assert.equal(label(later), 'Yesterday');
  assert.notEqual(later.find((r: any) => r.kind === 'day'), today.find((r: any) => r.kind === 'day'));
});

test('messages of one sender are one group up to 7 minutes apart and never across midnight or a status notice', () => {
  const t0 = new Date(2026, 10, 3, 12, 0, 0).getTime() / 1000;
  const flags = (list: any[]) => plain(buildRows(list, false, null, NOW).filter((r: any) => r.kind === 'msg').reverse().map((r: any) => [r.first, r.last]));
  assert.deepEqual(flags([msg({ id: 'a', created_at: t0 }), msg({ id: 'b', created_at: t0 + 6 * 60 })]), [[true, false], [false, true]], '6 minutes: one group');
  assert.deepEqual(flags([msg({ id: 'a', created_at: t0 }), msg({ id: 'b', created_at: t0 + 7 * 60 + 30 })]), [[true, true], [true, true]], '7.5 minutes: two groups');
  assert.deepEqual(flags([msg({ id: 'a', created_at: t0 }), msg({ id: 'b', created_at: t0 + 60, text: '⏳ Working on it' })]), [[true, true], [true, true]], 'a status notice stands alone');
  const night = new Date(2026, 10, 3, 23, 59, 0).getTime() / 1000;
  assert.deepEqual(flags([msg({ id: 'a', created_at: night }), msg({ id: 'b', created_at: night + 120 })]), [[true, true], [true, true]], 'across midnight');
});
