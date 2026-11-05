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
  assert.match(screen, /botActivityLabel\(rt\?\.botActivity\?\.\[x\.profile \?\? 'default'\]\)/);
  assert.match(screen, /accessibilityLabel="Working"/);
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
