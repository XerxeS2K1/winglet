import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { botName } = exports;

test("a bot's short name is a Hermes profile name", () => {
  assert.equal(botName('Meal Planner!'), 'meal-planner');
  assert.equal(botName('  Café Crème  '), 'cafe-creme');
  assert.equal(botName('---'), '');
  assert.equal(botName('A'.repeat(60)).length, 40);
  assert.equal(botName('R2-D2 / C-3PO'), 'r2-d2-c-3po');
});

const { resolveMainBot, mainFirst } = exports;
const bots = [{ id: 'a' }, { id: 'a~chef', parent: 'a' }, { id: 'b' }];

test('the main bot is the one chosen, else the first paired on its own', () => {
  assert.equal(resolveMainBot(bots, 'b').id, 'b');
  assert.equal(resolveMainBot(bots, 'a~chef').id, 'a~chef');
  assert.equal(resolveMainBot(bots, '').id, 'a');
  assert.equal(resolveMainBot(bots, 'gone').id, 'a'); // removed since it was chosen
  assert.equal(resolveMainBot([{ id: 'x~y', parent: 'x' }], undefined).id, 'x~y');
  assert.equal(resolveMainBot([], 'a'), undefined);
});

test('the main bot leads, the others keep their order', () => {
  const ids = (list: any[]) => Array.from(list, (x) => x.id); // the vm's arrays aren't this realm's
  assert.deepEqual(ids(mainFirst(bots, 'b')), ['b', 'a', 'a~chef']);
  assert.deepEqual(ids(mainFirst(bots)), ['a', 'a~chef', 'b']);
  assert.equal(mainFirst([]).length, 0);
});

test('the bot picker uses activity labels and a distinct accessible working dot', () => {
  const screen = readFileSync(new URL('../src/components/BotSwitcher.tsx', import.meta.url), 'utf8');
  // The row reads its profile's activity from the narrowed selection and labels that (behaviour: tests/botSwitcherRenders.test.ts).
  assert.match(screen, /rt\?\.botActivity\?\.\[x\.profile \?\? 'default'\]/);
  assert.match(screen, /botActivityLabel\(activity\)/);
  assert.match(screen, /accessibilityLabel="Working"/);
});

test('pending hand-offs do not claim that the teammate already answered', () => {
  const label = exports.handoffAnswerLabel ?? (() => 'answered');
  assert.equal(label({ bot: 'Chef', state: 'queued' }), 'Queued; the answer will appear here');
  assert.equal(label({ bot: 'Chef', state: 'answered' }), 'Chef answered');
  assert.equal(label({ bot: 'Chef', state: 'failed', failed: true }), 'No answer');
  assert.equal(label({ bot: 'Chef', failed: false }), 'Chef answered'); // older server
});

test('queue rows put the title on top, sender and position underneath, in canonical order, without touching the snapshot', () => {
  const rows = exports.botQueueRows ?? (() => undefined);
  const queue = [
    { id: 'two', sequence: 20, from: 'Research', title: 'Compare sources', preview: 'Compare the two sources and tell me', status: 'queued' },
    { id: 'one', sequence: 10, from: 'Hermes', title: 'Plan dinner', preview: 'Plan dinner for six', status: 'started' },
  ];
  const result = rows({ state: 'working', queued: 1, queue });
  assert.equal(result?.[0]?.title, 'Plan dinner');
  assert.equal(result?.[0]?.subtitle, '1. Hermes');
  assert.equal(result?.[0]?.value, 'Running');
  assert.equal(result?.[1]?.title, 'Compare sources');
  assert.equal(result?.[1]?.subtitle, '2. Research');
  assert.equal(queue[0].id, 'two');
  assert.equal(rows(undefined), undefined);
  assert.equal(rows({ state: 'idle', queued: 0, queue: null }), undefined);
  assert.equal(rows({ state: 'idle', queued: 0, queue: [] }).length, 0);
  assert.equal(rows({ state: 'unknown', queued: 1, queue })[0].value, 'Started (unconfirmed)');
});

test('a dispatcher job row that explains work the bot already shows is detail: no position, not a second Running', () => {
  const rows = exports.botQueueRows;
  const queue = [
    { id: 'job:1:0', sequence: 1e12, from: 'Dispatcher', title: 'Job: Read the code - research - attempt 1', status: 'started', detail: true },
    { id: 'bot:a', sequence: 5, from: 'Hermes', title: 'Read the code', status: 'started' },
    { id: 'bot:b', sequence: 6, from: 'Hermes', title: 'Next', status: 'queued' },
  ];
  const result = rows({ state: 'working', queued: 1, queue });
  assert.equal(JSON.stringify(result.map((r: any) => [r.title, r.subtitle, r.value])), JSON.stringify([
    ['Read the code', '1. Hermes', 'Running'],
    ['Next', '2. Hermes', 'Queued'],
    ['Job: Read the code - research - attempt 1', 'Dispatcher', 'Job'],
  ]));
  const own = rows({ state: 'working', queued: 0, queue: [{ id: 'job:1:0', sequence: 1e12, from: 'Dispatcher', title: 'Job: Build - coder - attempt 2', status: 'started' }] });
  assert.equal(`${own[0].subtitle}|${own[0].value}`, '1. Dispatcher|Running');   // no native row: the job row is the work
});

test('a server that sends no title still gets a short readable line from the preview', () => {
  const rows = exports.botQueueRows;
  const row = (extra: any) => rows({ state: 'idle', queued: 1, queue: [{ id: 'a', sequence: 1, from: 'Hermes', status: 'queued', ...extra }] })[0];
  assert.equal(row({ preview: 'Plan dinner for six' }).title, 'Plan dinner for six');
  assert.equal(row({ preview: 'Plan dinner', title: undefined }).title, 'Plan dinner');
  const long = "Puppet Master here, with Kraig's yes. New small item, same rules as before: own branch and worktree, tests first";
  assert.equal(row({ preview: long }).title, "Puppet Master here, with Kraig's yes. New small item, same\u2026");
  assert.equal(row({ preview: 'x'.repeat(300) }).title, 'x'.repeat(60) + '\u2026');
  assert.equal(row({ preview: 'a '.repeat(29) + 'bb' }).title, 'a '.repeat(29) + 'bb');   // exactly 60: whole
  for (const empty of [{}, { preview: '' }, { preview: '   ' }, { preview: 5 }, { preview: null }, { title: '', preview: '' }, { title: '  ', preview: '' }]) {
    assert.equal(row(empty).title, 'Hand-off', JSON.stringify(empty));        // never a blank line
  }
  assert.equal(row({ title: 5, preview: 'From the preview' }).title, 'From the preview');   // a title that is not text is ignored
  assert.equal(row({ title: '   ', preview: 'From the preview' }).title, 'From the preview');
});

test('a title is the sender\'s own text: shown as plain single-line text and capped', () => {
  const rows = exports.botQueueRows;
  const title = (value: string) => rows({ state: 'idle', queued: 1, queue: [{ id: 'a', sequence: 1, from: 'Hermes', title: value, preview: 'p', status: 'queued' }] })[0].title;
  assert.equal(title('  Plan \n\t dinner  '), 'Plan dinner');
  assert.equal(title('one\ntwo'), 'one two');       // a bare line break between words is a space, not nothing
  assert.equal(title('tab\tseparated'), 'tab separated');
  assert.equal(title('Plan\u0007 dinner\u200b'), 'Plan dinner');
  assert.equal(title('evil\u202egnp.exe'), 'evilgnp.exe');                      // no bidi override to reverse what is read
  assert.equal(title('line one\u2028line two'), 'line one line two');
  assert.equal(title('<b>bold</b> & [link](http://x)'), '<b>bold</b> & [link](http://x)');   // kept as text, never interpreted
  assert.equal(title('x'.repeat(500)).length <= 64, true);
  assert.equal(title('Pasta \u{1F35D} night'), 'Pasta \u{1F35D} night');
});

test('sender names are shown as plain text too', () => {
  const rows = exports.botQueueRows;
  const sub = (from: any) => rows({ state: 'idle', queued: 1, queue: [{ id: 'a', sequence: 1, from, title: 't', preview: 'p', status: 'queued' }] })[0].subtitle;
  assert.equal(sub('Hermes'), '1. Hermes');
  assert.equal(sub('Evil\u202e Bot\u0007'), '1. Evil Bot');
  assert.equal(sub(''), '1. Unknown sender');
  assert.equal(sub(undefined), '1. Unknown sender');
  assert.equal(sub(5), '1. Unknown sender');
});

test('the queue sheet renders rows as plain text rows and has no way to act on the queue', () => {
  const sheet = readFileSync(new URL('../src/components/QueueSheet.tsx', import.meta.url), 'utf8');
  assert.ok(sheet.includes('<ListRow') && sheet.includes('title={row.title}') && sheet.includes('subtitle={row.subtitle}'));
  assert.ok(!/dangerouslySetInnerHTML|<Markdown|WebView/.test(sheet), 'a title must never be interpreted as markup');
  assert.ok(!sheet.includes('signedApi'));
});

test('bot picker opens a read-only queue sheet that hides stale offline details', () => {
  const picker = readFileSync(new URL('../src/components/BotSwitcher.tsx', import.meta.url), 'utf8');
  assert.ok(picker.includes('<QueueSheet'), 'the queue sheet must be mounted in the picker');
  const sheet = readFileSync(new URL('../src/components/QueueSheet.tsx', import.meta.url), 'utf8');
  assert.ok(sheet.includes("rt?.status === 'online'"), 'offline snapshots must not be presented as live queues');
  assert.ok(sheet.includes('Read-only') && sheet.includes('Queue details unavailable'));
  assert.ok(!sheet.includes('signedApi'), 'the queue sheet has no scheduling mutations');
});

const { notRunning, teamworkOff } = exports;

test('activity labels keep queued work separate from approvals and unknown data', () => {
  const label = exports.botActivityLabel ?? (() => 'Online');
  assert.equal(label({ state: 'working', queued: 2 }), 'Working, 2 queued');
  assert.equal(label({ state: 'working', queued: 0 }), 'Working');
  assert.equal(label({ state: 'idle', queued: 0 }), 'Online');
  assert.equal(label({ state: 'idle', queued: 1 }), '1 queued');
  assert.equal(label({ state: 'unknown', queued: null }), 'Activity unavailable');
  assert.equal(label(undefined), 'Online'); // older servers are unchanged
});

test("a bot Hermes isn't running says so, and one whose state is unknown says nothing", () => {
  assert.equal(notRunning({ served: false }), 'Not running');
  assert.equal(notRunning({ served: true }), null);
  assert.equal(notRunning({}), null); // an older server doesn't say
});

test('the bots screen warns only when a multi-bot server says teamwork is off', () => {
  const two = [{ id: 'a' }, { id: 'b' }];
  assert.equal(teamworkOff(two, { a: { features: { bot_teamwork: false } } }), true);
  assert.equal(teamworkOff(two, { a: { features: { bot_teamwork: true } } }), false);
  assert.equal(teamworkOff(two, { a: { features: {} } }), false); // an older server doesn't say; stay quiet
  assert.equal(teamworkOff(two, {}), false);
  assert.equal(teamworkOff([{ id: 'a' }], { a: { features: { bot_teamwork: false } } }), false); // one bot: nothing to ask
});
