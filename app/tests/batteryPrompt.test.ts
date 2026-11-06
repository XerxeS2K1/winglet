import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAboutBatteryOnce, BATTERY_PROMPT_COPY, type BatteryDeps } from '../src/lib/batteryPrompt.ts';

/** A phone with scripted answers and a record of what the app did. */
function setup(over: { allowed?: boolean; asked?: boolean; answer?: boolean; android?: boolean; noNative?: boolean; oldBuild?: boolean } = {}) {
  const log: string[] = [];
  let asked = over.asked ?? false;
  const native = over.noNative ? null : over.oldBuild ? {} : {
    batteryUnrestricted: () => over.allowed ?? false,
    requestBatteryUnrestricted: () => { log.push('request'); },
  };
  const deps: BatteryDeps = {
    android: over.android ?? true,
    native,
    wasAsked: async () => asked,
    markAsked: async () => { asked = true; log.push('marked'); },
    confirm: async () => { log.push('shown'); return over.answer ?? true; },
  };
  return { deps, log, wasMarked: () => asked };
}

test('asks once, then opens Android\'s own dialog when the person agrees', async () => {
  const s = setup();
  assert.equal(await askAboutBatteryOnce(s.deps), 'requested');
  assert.deepEqual(s.log, ['marked', 'shown', 'request']);
});

test('it is marked as asked BEFORE the question appears, so a kill mid-dialog cannot repeat it', async () => {
  const s = setup();
  await askAboutBatteryOnce(s.deps);
  assert.ok(s.log.indexOf('marked') < s.log.indexOf('shown'));
});

test('"Not now" is final: nothing is requested and it never asks again', async () => {
  const s = setup({ answer: false });
  assert.equal(await askAboutBatteryOnce(s.deps), 'declined');
  assert.deepEqual(s.log, ['marked', 'shown']);
  assert.equal(await askAboutBatteryOnce(s.deps), 'already-asked');
  assert.deepEqual(s.log, ['marked', 'shown']);
});

test('a second start after answering does nothing', async () => {
  const s = setup({ asked: true });
  assert.equal(await askAboutBatteryOnce(s.deps), 'already-asked');
  assert.deepEqual(s.log, []);
});

test('already unrestricted: no question, and it is remembered', async () => {
  const s = setup({ allowed: true });
  assert.equal(await askAboutBatteryOnce(s.deps), 'already-allowed');
  assert.deepEqual(s.log, ['marked']);
});

test('not Android, no native module, or an older build without the functions: silently nothing', async () => {
  for (const over of [{ android: false }, { noNative: true }, { oldBuild: true }]) {
    const s = setup(over);
    assert.equal(await askAboutBatteryOnce(s.deps), 'unsupported');
    assert.deepEqual(s.log, []);
    assert.equal(s.wasMarked(), false); // a later build that can ask is still allowed to
  }
});

test('an error anywhere is swallowed, never thrown at start-up', async () => {
  const s = setup();
  s.deps.wasAsked = async () => { throw new Error('storage broke'); };
  assert.equal(await askAboutBatteryOnce(s.deps), 'failed');
});

test('the explanation names the action and says it is asked once', () => {
  assert.match(BATTERY_PROMPT_COPY.message, /Allow/);
  assert.match(BATTERY_PROMPT_COPY.message, /once/);
});
