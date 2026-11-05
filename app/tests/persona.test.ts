import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const screen = readFileSync(new URL('../src/app/persona.tsx', import.meta.url), 'utf8');

test('persona editor explains the scope before saving, including bot hand-offs', () => {
  const footnote = screen.match(/<Footnote>([^<]+)<\/Footnote>/)?.[1] ?? '';
  assert.match(footnote, /new chats/i);
  assert.match(footnote, /existing chats/i);
  assert.match(footnote, /hand-offs/i);
  assert.match(footnote, /keep their current persona/i);
});

test('successful persona save does not imply existing chats were refreshed', () => {
  const saved = screen.match(/setMessage\('(Saved[^']+)'\)/)?.[1] ?? '';
  assert.match(saved, /new chats/i);
  assert.match(saved, /existing chats/i);
  assert.match(saved, /hand-offs/i);
  assert.match(saved, /keep their current persona/i);
});
