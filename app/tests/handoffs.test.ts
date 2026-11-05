import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('handoff answer details render for notifiable bot messages, not only system notes', () => {
  const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
  const detail = source.indexOf('if (message.meta?.asked) return <AskedLine');
  const system = source.indexOf("if (message.role === 'system') {");
  assert.ok(detail >= 0 && detail < system, 'hand-off details must be checked before the system-only branch');
});
