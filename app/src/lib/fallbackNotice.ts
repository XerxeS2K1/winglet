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

/**
 * How long the primary model stays unretried. The server's absolute `retry_at` (epoch seconds) wins: it
 * survives a republish, a chat switch or an app restart, where counting from arrival does not.
 */
export function secondsLeft(fallback: FallbackInfo, arrivedAt: number, now: number): number | null {
  const relative = remainingSeconds(fallback.retry_in_s, arrivedAt, now);
  const at = fallback.retry_at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return relative;
  const absolute = at - Date.now() / 1000;
  // Two clocks, two failure modes: the relative count is immune to a wrong phone clock, the absolute
  // deadline is immune to a republish. Believing whichever is shorter means neither can lengthen it.
  return relative === null ? absolute : Math.min(relative, absolute);
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
  const left = secondsLeft(snapshot.fallback, snapshot.arrivedAt, now);
  return left !== null && left > 0;
}

export type StripText = { title: string; countdown: string; detail: string | null };

/** Hermes's reason words become the phrase the owner would use out loud. Anything unrecognised is kept. */
const REASON_WORDS: Record<string, string> = {
  'rate limit': 'rate limited', 'rate-limited': 'rate limited', 'rate_limited': 'rate limited',
  'provider unavailable': 'unavailable', 'unavailable': 'unavailable', 'overloaded': 'overloaded',
  'request timeout': 'timed out', 'timeout': 'timed out',
  'authentication failed': 'not signed in', 'auth failed': 'not signed in', 'unauthorised': 'not signed in',
  'server error': 'erroring',
};

/** `Claude` for a Claude model (the family is what the owner recognises), otherwise the model's own name. */
function primaryName(from: string): string | null {
  if (!from) return null;
  return /^claude/i.test(from) ? 'Claude' : modelName(from);
}

/** The strip's words: who is in trouble, what is being used instead, and the countdown when there is one. */
export function stripText(snapshot: FallbackSnapshot | null, now: number): StripText | null {
  if (!snapshot) return null;
  const { fallback, model } = snapshot;
  const raw = typeof fallback.reason === 'string' ? fallback.reason.split(/\s+/).filter(Boolean).join(' ') : '';
  const word = REASON_WORDS[raw.toLowerCase()] ?? raw;
  const left = secondsLeft(fallback, snapshot.arrivedAt, now);
  const primary = primaryName(typeof fallback.from_model === 'string' ? fallback.from_model : '');
  const using = model ? modelName(model) : '';

  // "Claude rate limited — using GPT-6.1 Sol": who, what went wrong, what is answering instead.
  const known = primary && word ? `${primary} ${word}` : word || primary || '';
  const lead = known ? known[0].toUpperCase() + known.slice(1) : '';
  const title = !lead ? (using ? `Using ${using}` : 'Fallback') : using ? `${lead} — using ${using}` : lead;

  // The right-hand side is a timer or nothing at all: no cooldown means no number to show.
  const countdown = left === null ? '' : formatCountdown(left);
  const who = primary ?? 'The main model';
  // Nothing known beyond the model in use: the title already says it, so there is no second line.
  const detail = !using || !lead ? null
    : countdown ? `${who} can be used again in ${countdown}`
    : `No retry time from the server; the next message tries ${who === 'The main model' ? 'it' : who} again`;
  return { title, countdown, detail };
}

/** One line while the keyboard is up or the window is short, two otherwise. An unknown size is not "short". */
export function stripLines(keyboardVisible: boolean, windowHeight: number): 1 | 2 {
  return keyboardVisible || windowHeight < COMPACT_HEIGHT_DP ? 1 : 2;
}
