import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { network, server } from './helpers/serverUpdateHarness.ts';
const source = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
test('there is one app update flow, no automatic server startup prompt or separate auto-update setting', () => {
  assert.doesNotMatch(source('app/_layout.tsx'), /<ServerUpdatePrompt/);
  assert.match(source('app/_layout.tsx'), /unifiedUpdate\.hydrate/);
  assert.doesNotMatch(source('app/settings.tsx') + source('lib/prefs.ts'), /autoUpdateServer|Auto-update server plugin/);
  assert.doesNotMatch(source('lib/serverUpdates.ts'), /skipUnlock/);
});
test('the consented handoff uses the same signed durable job sender without a second unlock', async () => {
  const h = network(); await h.core.sendConsentedWingletUpdate(server, { target: 'winglet', version: '0.10.8', idempotency_key: 'handoff' });
  assert.equal(h.prompts.length, 0); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][3].version, '0.10.8'); assert.equal(h.requests[0][3].idempotency_key, 'handoff');
  assert.equal(h.jobs.updateRecovery.snapshot(server).jobs[0].id, 'job');
});
