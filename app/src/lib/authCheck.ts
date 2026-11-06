/**
 * "Signed out" is permanent until the person re-pairs, so one bad reading must never be enough.
 *
 * After deep sleep a single request can be rejected for reasons that have nothing to do with the pairing (a request
 * sent before the network settled, a proxy answering for a moment). So the app asks again a couple of times, a few
 * seconds apart, and only says "Signed out" when EVERY answer is a rejection. Any other answer (fine, or a network
 * error) means "not proven" and the app keeps retrying.
 */
export const AUTH_RECHECK_DELAYS_MS = [2000, 5000];

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type AuthAnswer = 'rejected' | 'fine';

export async function confirmRejected(
  ask: () => Promise<AuthAnswer>,
  delays: number[] = AUTH_RECHECK_DELAYS_MS,
  wait: (ms: number) => Promise<void> = pause,
  stillWanted: () => boolean = () => true,
): Promise<boolean> {
  if (!stillWanted() || (await ask()) !== 'rejected') return false;
  for (const ms of delays) {
    await wait(ms);
    if (!stillWanted()) return false;
    if ((await ask()) !== 'rejected') return false;
  }
  return stillWanted();
}
