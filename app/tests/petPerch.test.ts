import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { boxStackHeight } from '../src/lib/petPerch.ts';

test('the pet rides on the box and its padding, not on whatever sits above the box', () => {
  assert.equal(boxStackHeight(96, 34), 130);
  assert.equal(boxStackHeight(96.4, 0), 106, 'a bare edge still leaves the 10 px of padding the composer applies');
  // The same box gives the same answer however tall the task card or chips above it are.
  assert.equal(boxStackHeight(96, 34), boxStackHeight(96, 34));
});

test('the chat pet is placed from the box height and the composer reports it', () => {
  const view = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
  const composer = readFileSync(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
  assert.match(view, /<ChatPet [^>]*composerHeight=\{boxStackH\}/);
  assert.doesNotMatch(view, /<ChatPet [^>]*composerHeight=\{composerH\}/);
  assert.match(view, /onBoxStackHeight=\{setBoxStackH\}/);
  assert.match(composer, /onBoxStackHeight\?\.\(boxStackHeight\(e\.nativeEvent\.layout\.height, bottomInset\)\)/);
});
