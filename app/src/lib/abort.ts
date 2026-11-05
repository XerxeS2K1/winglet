/**
 * Throws if the signal is already aborted. React Native's AbortSignal (the abort-controller polyfill) has no
 * `throwIfAborted`, so calling it on the phone failed with "undefined is not a function". Browsers and Node have it.
 */
export function throwIfAborted(signal: { aborted: boolean; reason?: unknown }): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Cancelled');
}
