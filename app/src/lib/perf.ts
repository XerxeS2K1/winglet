/**
 * Developer timing for Winglet: how long the app takes to start, how long a reply takes to appear, and
 * whether frames are dropped while one streams. Everything is measured on the phone and written to the
 * console (`adb logcat -s ReactNativeJS`); nothing is stored or sent anywhere.
 *
 * It is on in development builds and OFF in release builds. To measure a release build, build it with
 * `EXPO_PUBLIC_WINGLET_PERF=1` in the environment. `EXPO_PUBLIC_WINGLET_PERF=0` turns it off in development.
 *
 * Reply times are taken when the message update reaches the store, which is just before it is drawn: a frame
 * or two shorter than what the eye sees. The first-content mark is taken after the first frame following the
 * render, so it includes drawing.
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

// -- input and send event order ---------------------------------------------------------------------------
// Lengths, counts and booleans only: nothing a person typed, and nothing that identifies a message, a server or a login.

/** A JS-thread gap between two ticks longer than this is logged. */
export const STALL_GAP_MS = 100;
/** How often the stall watch ticks. A tick that arrives much later than this means the JS thread was busy. */
export const STALL_TICK_MS = 50;
/** Stop polling after a minute without input/send activity; the next event restarts it. */
export const STALL_IDLE_MS = 60_000;
/** How many sends are remembered by number at once; the oldest is forgotten first. */
export const SEND_LABELS_MAX = 64;

export type EventValue = number | boolean | string;

/** A field value that is safe to print: a finite number, a boolean, or a fixed busy-mode enum. */
export function safeValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?';
  if (typeof v === 'string' && ['interrupt', 'steer', 'queue'].includes(v)) return v;
  return '?';
}

/** `#12 +1234.5ms send-entry rendered=5 ready=true`. The name and keys come from this file, never from the user. */
export function eventLine(seq: number, tMs: number, name: string, fields: Record<string, EventValue> = {}): string {
  const rest = Object.keys(fields).map((k) => ` ${k}=${safeValue(fields[k])}`).join('');
  return `#${seq} +${safeValue(tMs)}ms ${name}${rest}`;
}

/** Gives each send a small number (1, 2, 3...) so the log can follow one send without printing its client id. */
export class SendLabels {
  private ids = new Map<string, number>();
  private next = 1;

  /** The number for this send, made on first sight. */
  label(clientId: string): number {
    const known = this.ids.get(clientId);
    if (known !== undefined) return known;
    const n = this.next++;
    this.ids.set(clientId, n);
    if (this.ids.size > SEND_LABELS_MAX) this.ids.delete(this.ids.keys().next().value as string);
    return n;
  }

  /** The number for a send already seen; undefined for one this phone did not start (so its echo is not logged). */
  peek(clientId: string): number | undefined { return this.ids.get(clientId); }
}

/** Notices when the time between two ticks is longer than the limit. Returns the gap, or null. */
export class StallDetector {
  private last: number | null = null;

  constructor(private readonly limit = STALL_GAP_MS) {}

  tick(now: number): number | null {
    const gap = this.last === null ? 0 : now - this.last;
    this.last = now;
    return gap > this.limit ? Math.round(gap) : null;
  }
}

// -- lines ------------------------------------------------------------------------------------------------

const ms = (n: number) => `${Math.round(n)} ms`;

export const coldStartLine = (what: string, sinceModuleMs: number, sinceTimeOriginMs: number | null) =>
  `cold start: ${what} painted ${ms(sinceModuleMs)} after the JS bundle began`
  + (sinceTimeOriginMs === null ? '' : ` (${ms(sinceTimeOriginMs)} on the runtime clock)`);

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
let painted = false;

/** The first real content (a chat list or a message list) is on screen. Logged once per launch. */
export function perfFirstContent(what: string): void {
  if (!PERF_ON || painted) return;
  painted = true;
  const draw = () => {
    const nowMs = clock();
    log(coldStartLine(what, nowMs - moduleStart, typeof performance !== 'undefined' ? performance.now() : null));
  };
  // After the frame that follows this render, so the mark includes drawing it.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(draw)); else draw();
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

// -- input and send order: running parts (the callers also check PERF_ON, so nothing is built when it is off) --

let eventSeq = 0;
let lastEventAt = 0;
const sendLabels = new SendLabels();
let stallTimer: ReturnType<typeof setInterval> | null = null;

function mark(name: string, fields?: Record<string, EventValue>): void {
  try {
    lastEventAt = clock();
    startStallWatch();
    log(eventLine(++eventSeq, clock(), name, fields));
  } catch { /* a diagnostic must never get in the way of the app */ }
}

/** One interval, started by the first event and only while PERF_ON; logs only the gaps above `STALL_GAP_MS`. */
function startStallWatch(): void {
  if (!PERF_ON || stallTimer !== null || typeof setInterval !== 'function') return;
  const detector = new StallDetector();
  detector.tick(clock());
  stallTimer = setInterval(() => {
    try {
      const now = clock();
      if (now - lastEventAt >= STALL_IDLE_MS) { perfStopStallWatch(); return; }
      const gap = detector.tick(now);
      if (gap !== null) log(eventLine(++eventSeq, now, 'js-stall', { gapMs: gap, tickMs: STALL_TICK_MS }));
    } catch { /* logging must not throw from a timer either */ }
  }, STALL_TICK_MS);
}

/** Test and tidy-up: stop the stall watch. */
export function perfStopStallWatch(): void {
  if (stallTimer !== null && typeof clearInterval === 'function') clearInterval(stallTimer);
  stallTimer = null;
}

/** The text box reported a change: the new length only. */
export function perfInput(len: number): void {
  if (PERF_ON) mark('input', { len });
}

/** The Send handler started. `rendered` is what it captured at render; `draft` is what the store holds right now. */
export function perfSendEntry(f: { rendered: number; draft: number; ready: boolean; busy: boolean; busyMode: string; withValue: boolean; inFlight: boolean }): void {
  if (PERF_ON) mark('send-entry', f);
}

/** The length handed to `sendDraft` and the store's draft length immediately after invocation, BEFORE awaiting admission. This does not mean posted or cleared. */
export function perfSendPassed(passed: number, draftAfter: number): void {
  if (PERF_ON) mark('send-passed', { passed, draftAfter });
}

/** sendDraft settled: accepted is its result, not HTTP delivery (offline admission is enough). */
export function perfSendSettled(accepted: boolean, draftAfter: number): void {
  if (PERF_ON) mark('send-settled', { accepted, draftAfter });
}

/** A step of one send in the store: 'outbox', 'deferred', 'post-start', 'http-return', 'http-error'. */
export function perfSendStage(clientId: string, stage: 'outbox' | 'deferred' | 'post-start' | 'http-return' | 'http-error', f: Record<string, EventValue> = {}): void {
  if (PERF_ON) mark(stage, { send: sendLabels.label(clientId), ...f });
}

/** The server's copy of a message arrived on the socket. Logged only for sends this phone started. */
export function perfSendEcho(clientId: string): void {
  if (!PERF_ON) return;
  const n = sendLabels.peek(clientId);
  if (n !== undefined) mark('socket-echo', { send: n });
}

// -- checkpoint save cost: what one save actually writes --------------------------------------------------
// Counts and lengths again, never content. A save has to be proportional to what changed, and only the phone
// can say what a real chat page costs: `chars` is the JSON handed to the sealer, so the sealed value stored
// on disk is that text encrypted and base64-encoded — about a third longer, plus the nonce and tag.

export type SaveMeasure = { records: number; chars: number; largest: number };

/** How much text one save seals: one JSON string per record, plus the largest of them. */
export function measureSave(write: { key: string; value: unknown }[]): SaveMeasure {
  let chars = 0;
  let largest = 0;
  for (const { value } of write) {
    let n = 0;
    try { n = JSON.stringify(value)?.length ?? 0; } catch { n = 0; }
    chars += n;
    if (n > largest) largest = n;
  }
  return { records: write.length, chars, largest };
}

/** `checkpoint save: records=3 chars=412345 largest=409912 ms=24` */
export const saveLine = (m: SaveMeasure, elapsedMs: number) =>
  `checkpoint save: records=${m.records} chars=${m.chars} largest=${m.largest} ms=${Math.round(elapsedMs)}`;

/** The clock value to hand back to `perfSaveDone`; 0 when the switch is off. */
export function perfSaveStart(): number {
  return PERF_ON ? clock() : 0;
}

/** A checkpoint save finished writing: log its cost. No awaits, no writes, and it never throws. */
export function perfSaveDone(write: { key: string; value: unknown }[], startedAt: number): void {
  if (!PERF_ON) return;
  const elapsed = clock() - startedAt; // read before the measuring, so the probe is not counted as save time
  try {
    log(saveLine(measureSave(write), elapsed));
  } catch { /* a diagnostic must never get in the way of a save */ }
}
