import assert from 'node:assert/strict';
import test from 'node:test';
import { throwIfAborted } from '../src/lib/abort.ts';

// The React Native polyfill: only `aborted`, no `reason`, no `throwIfAborted`.
const polyfillSignal = (aborted: boolean) => ({ aborted });

test('does nothing for a signal that is not aborted', () => {
  assert.doesNotThrow(() => throwIfAborted(polyfillSignal(false)));
});

test('throws Cancelled for an aborted polyfill signal (no throwIfAborted method)', () => {
  const signal = polyfillSignal(true);
  assert.equal((signal as any).throwIfAborted, undefined);
  assert.throws(() => throwIfAborted(signal), /Cancelled/);
});

test('works with a real AbortSignal and keeps its reason', () => {
  const c = new AbortController();
  c.abort(new Error('stopped by user'));
  assert.throws(() => throwIfAborted(c.signal), /stopped by user/);
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
});
