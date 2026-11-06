import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmRejected, AUTH_RECHECK_DELAYS_MS, type AuthAnswer } from '../src/lib/authCheck.ts';

const noWait = async () => {};
const script = (answers: AuthAnswer[]) => { let i = 0; const calls = { n: 0 }; return { calls, ask: async () => { calls.n += 1; return answers[Math.min(i++, answers.length - 1)]; } }; };

test('every check rejected: confirmed, after the first look plus each re-check', async () => {
  const s = script(['rejected']);
  assert.equal(await confirmRejected(s.ask, [1, 1], noWait), true);
  assert.equal(s.calls.n, 3);
});

test('a single acceptance anywhere in the sequence means not confirmed, and it stops asking', async () => {
  for (const [answers, asked] of [[['fine'], 1], [['rejected', 'fine'], 2], [['rejected', 'rejected', 'fine'], 3]] as const) {
    const s = script([...answers]);
    assert.equal(await confirmRejected(s.ask, [1, 1], noWait), false);
    assert.equal(s.calls.n, asked);
  }
});

test('it waits the given gaps between checks', async () => {
  const waits: number[] = [];
  await confirmRejected(script(['rejected']).ask, [2000, 5000], async (ms) => { waits.push(ms); });
  assert.deepEqual(waits, [2000, 5000]);
});

test('it gives up quietly when the caller no longer wants the answer', async () => {
  let wanted = true;
  const s = script(['rejected']);
  const result = await confirmRejected(s.ask, [1, 1], async () => { wanted = false; }, () => wanted);
  assert.equal(result, false);
  assert.equal(s.calls.n, 1);
});

test('the real gaps give a bad reading time to clear without making a real sign-out slow', () => {
  assert.ok(AUTH_RECHECK_DELAYS_MS.length >= 2);
  assert.ok(AUTH_RECHECK_DELAYS_MS.reduce((a, b) => a + b, 0) <= 10000);
});
