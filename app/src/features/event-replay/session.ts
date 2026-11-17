/** At-least-once replay, serialized application, and durable checkpoints per authenticated scope. */
import type { SyncState } from '../../lib/types';
import { eventStreamInfo, journalEvent, orderJournalEvents, resumeReply, syncSnapshot,
  type EventStreamInfo, type JournalEvent, type SyncSnapshot } from './protocol';

export type ReplayCursor = { epoch: string; scope: string; cursor: number };
export type SyncHost = {
  read(): ReplayCursor | undefined;
  /** Must persist applied state AND this cursor atomically; rejects on storage failure. */
  write(cursor: ReplayCursor): Promise<void>;
  apply(event: any, replayed?: boolean): void | Promise<void>;
  applySnapshot(snapshot: SyncSnapshot): Promise<void>;
  fetch(): Promise<unknown>;
  view(view: SyncState): void;
  disconnect(): void;
};
const MAX_HELD = 512;
const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_PAGES = 12;
export class SyncSession {
  private stream?: EventStreamInfo;
  private cursor?: ReplayCursor;
  private state: SyncState = { phase: 'unsupported', caught: 0 };
  private held: JournalEvent[] = [];
  private generation = 0;
  private pages = 0;
  private queued = 0;
  private bytes = 0;
  private heldBytes = 0;
  /** Highest live seq applied whose save has not resolved yet; 0 when nothing is pending. */
  private pending = 0;
  private chain = Promise.resolve();
  /** Set once this session has decided to give itself up: no new frame is applied after that. */
  private givingUp = false;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private host: SyncHost, private send: (frame: any) => void) {}
  view() { return this.state; }
  /** The cursor this session has proven durable: it is only replaced once its write resolved. */
  durable(): ReplayCursor | undefined { return this.cursor; }
  closed() {
    this.generation++; this.stream = undefined; this.cursor = undefined;
    this.held = []; this.pages = 0; this.bytes = 0; this.heldBytes = 0; this.queued = 0; this.pending = 0;
    this.givingUp = false;
    clearTimeout(this.timeout); this.chain = Promise.resolve();
    this.show('idle');
  }
  /**
   * Write a burst that was applied but is still only in memory, before the caller gives the session
   * up. `closed()` throws the pending mark away, so every boundary that ends the session — a dropped
   * socket, a background, a dispose — has to flush first or the newest transcript is lost with it and
   * recovery depends on the server's journal. One save covers the whole burst, so coalescing holds.
   * A failed flush blocks and propagates like any other failed save instead of vanishing with the
   * queue. Never call this from inside the queue: it waits for the queue to drain.
   */
  async flush(): Promise<void> {
    const generation = this.generation;
    try { await this.chain; } catch { /* the frame that failed already reported itself */ }
    if (generation !== this.generation || !this.pending || !this.stream) return;
    const cursor = { scope: this.stream.scope, epoch: this.stream.epoch, cursor: this.pending };
    this.pending = 0;
    try { await this.save(cursor, generation); }
    catch (error) {
      if (generation === this.generation) this.show('blocked', 'network');
      throw error;
    }
  }
  /** Give the session up, but only once a burst it still holds is on disk. */
  async end(): Promise<void> {
    const generation = this.generation;
    let failed = false;
    try { await this.flush(); } catch { failed = true; }
    // A flush that outlived the socket's own retry belongs to the session that has already gone: the
    // reconnect called closed() and a fresh hello filled in the new stream, cursor and pending mark, and
    // clearing those here would leave a live socket that never saves again.
    if (generation !== this.generation) return;
    this.closed();
    // closed() reports idle; a burst that never reached the disk has to keep saying so.
    if (failed) this.show('blocked', 'network');
  }
  /**
   * Give the session up at a boundary it owns — a queue that overran, a resume that never came. That
   * is the same flush-then-close path as a drop and a dispose, so a pending burst still reaches the
   * disk, but the socket is not left open waiting on a disk that may never answer: the disconnect
   * happens now and end() reports blocked when the flush could not complete.
   */
  private giveUp() {
    if (this.givingUp) return;
    this.givingUp = true;
    const flushed = this.end(); // starts the flush; nothing new is applied from here on
    this.host.disconnect();
    void flushed;
  }
  /** The queue includes async persistence. A slow/full device disconnects before memory grows unbounded. */
  receive(event: any): Promise<void> {
    if (this.givingUp) return Promise.resolve();
    const generation = this.generation;
    const size = JSON.stringify(event).length * 2;
    this.queued++; this.bytes += size;
    if (this.queued + this.held.length > MAX_HELD || this.bytes + this.heldBytes > MAX_BYTES) {
      this.giveUp(); return Promise.resolve();
    }
    const work = this.chain.then(async () => {
      if (generation !== this.generation) return;
      try { await this.process(event, generation); await this.settle(generation); }
      catch { if (generation === this.generation) this.show('blocked', 'network'); }
      finally { if (generation === this.generation) { this.queued--; this.bytes -= size; } }
    });
    this.chain = work; return work;
  }
  retry() {
    if (!this.stream) return;
    void this.receive({ type: 'sync.retry' });
  }
  private show(phase: SyncState['phase'], reason?: SyncState['reason']) {
    this.state = { phase, caught: this.state.caught, reason }; this.host.view(this.state);
  }
  private request() {
    if (!this.cursor) return;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.giveUp(), 15000);
    this.send({ type: 'resume', ...this.cursor });
  }
  private async save(cursor: ReplayCursor, generation: number) {
    await this.host.write(cursor);
    if (generation === this.generation) this.cursor = cursor;
  }
  /**
   * Commit what a burst applied, once, when nothing else is waiting in the queue. The pending mark is
   * claimed before the write: if the write fails, the cursor stays where it was (the data on disk is
   * ahead of it, never behind) and the error reaches the caller as before.
   */
  private async settle(generation: number) {
    if (!this.pending || !this.stream || this.queued > 1 || generation !== this.generation) return;
    const cursor = { scope: this.stream.scope, epoch: this.stream.epoch, cursor: this.pending };
    this.pending = 0;
    await this.save(cursor, generation);
  }
  private async apply(events: JournalEvent[]) {
    const floor = this.cursor?.cursor ?? 0;
    for (const event of orderJournalEvents(events)) {
      if (event.event_seq <= floor) continue;
      await this.host.apply(event, true); this.state.caught++;
    }
  }
  private async process(event: any, generation: number): Promise<void> {
    if (event?.type === 'hello') {
      await this.host.apply(event);
      this.stream = event.features?.event_replay === true ? eventStreamInfo(event.event_stream) : undefined;
      this.state.caught = 0; this.pages = 0; this.held = []; this.heldBytes = 0; this.pending = 0;
      if (!this.stream) { this.show('unsupported'); return; }
      const saved = this.host.read();
      if (!saved || saved.scope !== this.stream.scope || saved.epoch !== this.stream.epoch ||
          !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > this.stream.watermark) {
        await this.snapshot(generation); return;
      }
      this.cursor = saved; this.show('catching-up'); this.request(); return;
    }
    if (event?.type === 'sync.retry') { await this.snapshot(generation); return; }
    if (event?.type === 'resume') {
      if (this.state.phase !== 'catching-up' || !this.stream) return;
      clearTimeout(this.timeout);
      const reply = resumeReply(event);
      if (!reply || !reply.ok || reply.scope !== this.stream.scope || reply.epoch !== this.stream.epoch ||
          !this.cursor || reply.cursor < this.cursor.cursor || reply.watermark < this.cursor.cursor ||
          (reply.has_more && reply.cursor === this.cursor.cursor)) {
        await this.snapshot(generation); return;
      }
      if (reply.events.some(e => e.type === 'sync.hint')) { await this.snapshot(generation); return; }
      await this.apply(reply.events);
      await this.save({ scope: reply.scope, epoch: reply.epoch, cursor: reply.has_more ? reply.cursor : reply.watermark }, generation);
      if (generation !== this.generation) return;
      if (reply.has_more) {
        if (++this.pages > MAX_PAGES) { await this.snapshot(generation); return; }
        this.request(); this.show('catching-up'); return;
      }
      await this.apply(this.held);
      const high = this.held.reduce((n, e) => Math.max(n, e.event_seq), this.cursor!.cursor);
      this.held = []; this.heldBytes = 0;
      await this.save({ ...this.cursor!, cursor: high }, generation);
      if (generation === this.generation) this.show('idle');
      return;
    }
    const journal = journalEvent(event);
    if (!this.stream || !journal) { await this.host.apply(event); return; }
    if (this.state.phase === 'catching-up' || this.state.phase === 'snapshot' || this.state.phase === 'blocked') {
      this.held.push(journal); this.heldBytes += JSON.stringify(journal).length * 2;
      if (this.held.length >= MAX_HELD || this.heldBytes > MAX_BYTES) { this.closed(); this.host.disconnect(); }
      return;
    }
    if (journal.event_seq <= Math.max(this.cursor?.cursor ?? 0, this.pending)) return;
    await this.host.apply(event);
    // While more frames are already waiting, the last of them commits what this one applied: a burst
    // costs one save, and the cursor still only moves once that save has resolved.
    this.pending = Math.max(this.pending, journal.event_seq);
  }
  private async snapshot(generation: number) {
    clearTimeout(this.timeout); this.show('snapshot');
    this.pending = 0; // a snapshot replaces the state, so nothing applied earlier is waiting to be saved
    try {
      const snapshot = syncSnapshot(await this.host.fetch());
      if (generation !== this.generation) return;
      if (!snapshot || !this.stream || snapshot.scope !== this.stream.scope) throw Error('scope');
      await this.host.applySnapshot(snapshot);
      if (generation !== this.generation) return;
      this.stream = { ...this.stream, epoch: snapshot.epoch };
      await this.save({ scope: snapshot.scope, epoch: snapshot.epoch, cursor: snapshot.watermark }, generation);
      if (generation !== this.generation) return;
      // Replay AFTER snapshot/history fetch; held frames alone cannot prove subscription coverage.
      this.show('catching-up'); this.pages = 0; this.request();
    } catch { if (generation === this.generation) this.show('blocked', 'network'); }
  }
}
