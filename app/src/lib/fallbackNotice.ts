import { modelName } from './modelOptions';
import type { FallbackInfo } from './types';

/** Below this window height (dp) the strip keeps to one line, so it never crowds the conversation. */
export const COMPACT_HEIGHT_DP = 560;
export const NEXT_MESSAGE = 'next message';

/** What the strip needs, fixed at the moment the server's answer arrived. */
export type FallbackSnapshot = { fallback: FallbackInfo; model: string; arrivedAt: number };

/** Milliseconds on a clock the phone's clock settings cannot move, so a countdown never jumps or runs backwards. */
export const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Only an explicit `active: true` counts: an old server (no key), `{}` or anything odd shows nothing. */
export function isFallbackActive(value: unknown): value is FallbackInfo {
  return typeof value === 'object' && value !== null && (value as { active?: unknown }).active === true;
}

/** The strip's input from `/api/agent`'s chat, or null when the agent is not on a fallback. */
export function snapshotOf(chat: { model?: string; fallback?: unknown } | null | undefined, arrivedAt: number): FallbackSnapshot | null {
  if (!chat || !isFallbackActive(chat.fallback)) return null;
  return { fallback: chat.fallback, model: typeof chat.model === 'string' ? chat.model : '', arrivedAt };
}

/** Seconds left of the server's cooldown now, or null when there is no cooldown (or it is not a plain number). */
export function remainingSeconds(retryInSeconds: unknown, arrivedAt: number, now: number): number | null {
  if (typeof retryInSeconds !== 'number' || !Number.isFinite(retryInSeconds)) return null;
  return retryInSeconds - Math.max(0, now - arrivedAt) / 1000;
}

/** `45 s`, `12 min`, `1 h 52 min`, always rounded up; nothing left or no cooldown reads `next message`. */
export function formatCountdown(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return NEXT_MESSAGE;
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.ceil(whole / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** Whether a once-a-second tick still changes anything on screen. */
export function isTicking(snapshot: FallbackSnapshot | null, now: number): boolean {
  if (!snapshot) return false;
  const left = remainingSeconds(snapshot.fallback.retry_in_s, snapshot.arrivedAt, now);
  return left !== null && left > 0;
}

export type StripText = { title: string; countdown: string; detail: string | null };

/** The strip's words. The reason is Hermes's own, tidied onto one line; the view cuts it with "…" if it must. */
export function stripText(snapshot: FallbackSnapshot | null, now: number): StripText | null {
  if (!snapshot) return null;
  const { fallback, model } = snapshot;
  const reason = typeof fallback.reason === 'string' ? fallback.reason.split(/\s+/).filter(Boolean).join(' ') : '';
  const left = remainingSeconds(fallback.retry_in_s, snapshot.arrivedAt, now);
  let detail: string | null = null;
  if (model) {
    detail = `Using ${modelName(model)}`;
    if (left === null) {
      const from = typeof fallback.from_model === 'string' ? fallback.from_model : '';
      // The approved mock-up says "Claude is tried again", so a Claude model is named by its family.
      const primary = !from ? 'The main model' : /^claude/i.test(from) ? 'Claude' : modelName(from);
      detail += ` \u00b7 ${primary} is tried again when you send`;
    }
  }
  return { title: reason ? `Fallback \u00b7 ${reason}` : 'Fallback', countdown: formatCountdown(left), detail };
}

/** One line while the keyboard is up or the window is short, two otherwise. An unknown size is not "short". */
export function stripLines(keyboardVisible: boolean, windowHeight: number): 1 | 2 {
  return keyboardVisible || windowHeight < COMPACT_HEIGHT_DP ? 1 : 2;
}
