import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');

test('the app has one plain app-update flow and no server-update orchestration', () => {
  assert.doesNotMatch(source('app/_layout.tsx'), /UnifiedUpdateHost|UpdateJobHost|unifiedUpdate\.hydrate/);
  assert.doesNotMatch(source('lib/unifiedUpdate.ts'), /from '\.\/api'|from '\.\/serverUpdates'|signedApi|api</);
  assert.doesNotMatch(source('lib/serverUpdates.ts'), /signedApi|updateServerWinglet|sendConsentedWingletUpdate/);
  assert.doesNotMatch(source('lib/serverUpdates.ts'), /\/api\/system\/update['"`]/);
  assert.ok(!existsSync(new URL('../src/lib/updateRecovery.ts', import.meta.url)));
  assert.ok(!existsSync(new URL('../src/lib/updateJobs.ts', import.meta.url)));
  assert.ok(!existsSync(new URL('../src/components/UnifiedUpdateHost.tsx', import.meta.url)));
  assert.ok(!existsSync(new URL('../src/components/UpdateJobHost.tsx', import.meta.url)));
});

test('the Server screen keeps the deliberate Hermes update but has no Winglet update row', () => {
  const server = source('app/server.tsx');
  assert.match(server, /target: what/);
  assert.match(server, /name="Hermes"/);
  assert.doesNotMatch(server, /name="Winglet"/);
  assert.doesNotMatch(server, /updateServerWinglet|updateRecovery|Server plugin update/);
});

test('the Server screen reads the server setting and writes only autoUpdate', () => {
  const about = source('components/ServerAutoUpdate.tsx');
  assert.match(about, /api<\{ autoUpdate: boolean \}>\(server, '\/api\/settings'\)/);
  assert.match(about, /signedApi<\{ autoUpdate: boolean \}>\(server, 'PUT', '\/api\/settings', \{ autoUpdate: on \}\)/);
});
