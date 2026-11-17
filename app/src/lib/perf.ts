/**
 * Developer timing for Winglet: how long the app takes to start, how long a reply takes to appear, and
 * whether frames are dropped while one streams. Everything is measured on the phone and written to the
 * console (`adb logcat -s ReactNativeJS`); nothing is stored or sent anywhere.
 *
 * It is on in development builds and OFF in release builds. To measure a release build, build it with
 * `EXPO_PUBLIC_WINGLET_PERF=1` in the environment. `EXPO_PUBLIC_WINGLET_PERF=0` turns it off in development.
 *
 * Reply times are taken when the message update reaches the store, which is just before it is drawn: a frame
 * or two shorter than what the eye sees. The first-content mark is taken at the moment React commits the
 * render that puts the content on screen; how long that commit then took to reach a frame is a line of its
 * own, and a frame that never comes cannot swallow the mark.
 */

/** The one switch. Pure so it can be tested: dev builds default on, release builds default off. */
export function perfSwitch(dev: boolean | undefined, flag: string | undefined): boolean {
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !!dev;
}

/** A frame later than this after the previous one is counted as dropped (two frames at 60 Hz). */
export const SLOW_FRAME_MS = 32;
/** A reply that never finishes streaming stops being watched after this long, so the frame loop cannot run forever. */
export const STREAM_GIVE_UP_MS = 60_000;

// -- reply timing -----------------------------------------------------------------------------------------

export type ReplyObservation = { id: string; streaming: boolean; hasText: boolean };
export type ReplyTiming = { firstTextMs: number; totalMs: number; streamMs: number; updates: number };
export type ReplyStep = { first?: number; done?: ReplyTiming };

type Pending = { sentAt: number; anchor?: string; firstAt?: number; updates: number };

/**
 * Per chat: from the moment you send to the first assistant text, and to the last update of that message.
 * The "reply" is the first assistant message that has text after the send; tool-progress bubbles and your
 * own echo are not offered to it (the caller passes `hasText` false for them).
 */
export class ReplyTimer {
  private pending = new Map<string, Pending>();

  /** Start timing a chat's next reply. A second send before the reply restarts the clock. */
  sent(chat: string, now: number): void {
    this.pending.set(chat, { sentAt: now, updates: 0 });
  }

  /** Feed one assistant message update. Returns the first-text time once and the whole timing at the end. */
  observe(chat: string, m: ReplyObservation, now: number): ReplyStep {
    const p = this.pending.get(chat);
    if (!p || !m.hasText) return {};
    const step: ReplyStep = {};
    if (p.anchor === undefined) {
      p.anchor = m.id;
      p.firstAt = now;
      step.first = now - p.sentAt;
    }
    if (p.anchor !== m.id) return step;
    p.updates += 1;
    if (!m.streaming) {
      this.pending.delete(chat);
      step.done = { firstTextMs: (p.firstAt ?? now) - p.sentAt, totalMs: now - p.sentAt, streamMs: now - (p.firstAt ?? now), updates: p.updates };
    }
    return step;
  }

  /** Chats still waiting for a reply (for tests and tidy-up). */
  get size(): number { return this.pending.size; }
}

// -- dropped frames while streaming -----------------------------------------------------------------------

export type FrameSummary = { frames: number; slow: number; worstMs: number; spanMs: number };

/** Counts frames and the ones that arrived later than `SLOW_FRAME_MS` after the one before. */
export class FrameMeter {
  private last: number | null = null;
  private first: number | null = null;
  private frames = 0;
  private slow = 0;
  private worst = 0;

  constructor(private readonly threshold = SLOW_FRAME_MS) {}

  tick(now: number): void {
    if (this.last !== null) {
      const gap = now - this.last;
      this.frames += 1;
      if (gap > this.threshold) this.slow += 1;
      if (gap > this.worst) this.worst = gap;
    } else {
      this.first = now;
    }
    this.last = now;
  }

  summary(): FrameSummary {
    return { frames: this.frames, slow: this.slow, worstMs: Math.round(this.worst), spanMs: this.first === null || this.last === null ? 0 : Math.round(this.last - this.first) };
  }
}

/** Which messages are streaming. Says when the first one starts and the last one ends, so the frame loop runs only then. */
export class StreamingGate {
  private live = new Set<string>();

  /** 'start' when the first message begins streaming, 'stop' when the last one ends, otherwise null. */
  update(id: string, streaming: boolean): 'start' | 'stop' | null {
    const before = this.live.size;
    if (streaming) this.live.add(id); else this.live.delete(id);
    if (before === 0 && this.live.size > 0) return 'start';
    if (before > 0 && this.live.size === 0) return 'stop';
    return null;
  }

  clear(): boolean {
    const had = this.live.size > 0;
    this.live.clear();
    return had;
  }
}

// -- lines ------------------------------------------------------------------------------------------------

const ms = (n: number) => `${Math.round(n)} ms`;

export const coldStartLine = (what: string, sinceModuleMs: number) =>
  `cold start: ${what} committed ${ms(sinceModuleMs)} after the JS bundle began`;

/** The frame-deferred part, reported on its own so it can never delay or replace the mark above. */
export const coldStartDrawnLine = (what: string, drawMs: number, sinceModuleMs: number) =>
  `cold start: ${what} drawn ${ms(drawMs)} after that commit (${ms(sinceModuleMs)} after the JS bundle began)`;

export const replyFirstLine = (firstTextMs: number) => `reply: first text ${ms(firstTextMs)} after send`;

export const replyDoneLine = (t: ReplyTiming) =>
  `reply: finished ${ms(t.totalMs)} after send (first text ${ms(t.firstTextMs)}, streaming ${ms(t.streamMs)}, ${t.updates} updates)`;

export const frameLine = (f: FrameSummary) =>
  `frames while streaming: ${f.slow} slow (> ${SLOW_FRAME_MS} ms) of ${f.frames} over ${ms(f.spanMs)}, worst gap ${ms(f.worstMs)}`;

// -- the running parts: nothing below does anything when the switch is off ---------------------------------

export const PERF_ON = perfSwitch(typeof __DEV__ === 'undefined' ? undefined : __DEV__, process.env.EXPO_PUBLIC_WINGLET_PERF);

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const moduleStart = clock();

const log = (line: string) => { console.log(`[winglet-perf] ${line}`); };

const replies = new ReplyTimer();
const gate = new StreamingGate();
let meter: FrameMeter | null = null;
let frameHandle: number | null = null;
let giveUp: ReturnType<typeof setTimeout> | null = null;
let launchMarked = false;

/**
 * The launch's first real content is on screen. Logged exactly once per launch, and written straight away.
 *
 * The figure is the time from the JS bundle starting to this call. React runs the effect that calls this after
 * it has committed the render, so the number is the commit, not whenever a frame callback happened to run. That
 * matters on a phone whose screen was asleep or whose JS thread was busy: the delay shows up as drawing lag
 * below, instead of being counted as launch time.
 *
 * A frame that is slow to arrive is reported on a line of its own, and a frame that never arrives at all costs
 * the mark nothing, because the mark has already been written.
 */
export function perfFirstContent(what: string): void {
  if (!PERF_ON || launchMarked) return;
  launchMarked = true;
  const committedMs = clock() - moduleStart;
  log(coldStartLine(what, committedMs));
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    const nowMs = clock() - moduleStart;
    log(coldStartDrawnLine(what, nowMs - committedMs, nowMs));
  });
}

/** You pressed send in this chat. */
export function perfMessageSent(chat: string): void {
  if (PERF_ON) replies.sent(chat, clock());
}

/** A bot message arrived or changed in this chat. `replayed` updates are old news from a reconnect: not timed. */
export function perfMessageUpdate(chat: string, m: ReplyObservation, replayed = false): void {
  if (!PERF_ON || replayed) return;
  const step = replies.observe(chat, m, clock());
  if (step.first !== undefined) log(replyFirstLine(step.first));
  if (step.done) log(replyDoneLine(step.done));
  streamingChanged(gate.update(`${chat}:${m.id}`, m.streaming));
}

function streamingChanged(change: 'start' | 'stop' | null): void {
  if (change === 'start') startFrames();
  else if (change === 'stop') stopFrames();
}

function startFrames(): void {
  if (typeof requestAnimationFrame !== 'function') return;
  meter = new FrameMeter();
  const step = () => {
    if (!meter) return;
    meter.tick(clock());
    frameHandle = requestAnimationFrame(step);
  };
  frameHandle = requestAnimationFrame(step);
  giveUp = setTimeout(() => { gate.clear(); stopFrames(); }, STREAM_GIVE_UP_MS);
}

function stopFrames(): void {
  if (frameHandle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
  if (giveUp !== null) clearTimeout(giveUp);
  frameHandle = null;
  giveUp = null;
  if (meter) log(frameLine(meter.summary()));
  meter = null;
}
