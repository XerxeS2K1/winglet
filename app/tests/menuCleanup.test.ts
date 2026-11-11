import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Menu clean-up: one home per concept. These read the screen source because the screens need React Native to run.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the Agent hub no longer lists Schedule or Logs, and its history group is called History', () => {
  const hub = source('app/(tabs)/agent.tsx');
  assert.doesNotMatch(hub, /title="Schedule"|title="Logs"|'\/schedule'|'\/logs'/);
  assert.match(hub, /title="History"/);
  assert.doesNotMatch(hub, /Automation & history/);
  assert.match(hub, /key="checkpoints"/);
  assert.match(hub, /key="sessions"/);
});
