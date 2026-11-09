import type { AppUpdate } from './appUpdate';
import type { Job, Server } from './types';
import { isTransientServerError } from './api';
import { updateScope } from './updateRecovery';
import { compareVersions } from './version';

type Stage = 'awaiting-app' | 'dispatching' | 'tracking' | 'unknown' | 'failed' | 'complete';
export type Handoff = { version: string; key: string; scope?: string; serverName?: string; role?: string; stage: Stage; message: string; jobId?: string; created?: number };
export type UpdateContext = { current: string; server?: Server; servers?: Server[]; runtime?: Record<string, { me?: { role?: string } }>; role?: string; online: boolean; foreground: boolean; locked: boolean };
type Deps = {
  read: () => Promise<Handoff | null>; write: (value: Handoff | null) => Promise<void>;
  context: () => UpdateContext; authenticate: (prompt: string) => Promise<boolean>; key: () => string;
  install: (update: AppUpdate, eligible: () => boolean) => Promise<string>; abort: () => void;
  system: (server: Server) => Promise<{ version: string }>;
  send: (server: Server, body: Record<string, string>, eligible: () => boolean) => Promise<Job | null>;
  recover: (server: Server, jobId?: string, version?: string, created?: number) => Promise<Job | undefined>; acknowledge: (server: Server, record: Handoff) => Promise<void>;
};
const versionOK = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const scope = (c: UpdateContext) => c.server ? updateScope(c.server) : undefined;
const CONSENT_TTL = 7 * 24 * 60 * 60 * 1000;
/** The plugin install restarts the gateway; a 5xx while it does is the update, not a failure. */
const RESTART_PATIENCE = 90_000;
const RESTART_STAGES: Stage[] = ['awaiting-app', 'dispatching', 'tracking', 'unknown'];
const RESTART_NOTICE = 'The server is restarting to finish the update. Waiting for it to come back…';

/** A one-tap, release-bound consent, not a general permission to update servers on startup. */
export class UnifiedUpdate {
  record: Handoff | null = null;
  loaded = false;
  working = false;
  /** Kept for the current notice; the next start or refresh begins a new attempt. */
  error = '';
  /** A saved record that cannot be read at all; the app must still be updateable. */
  notice = '';
  private unreadable: Handoff | null = null;
  /** True when the persisted record could not be read at all (parse/decrypt/storage failure). */
  private readFailed = false;
  private epoch = 0;
  private transientSince = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private loading?: Promise<void>;
  private observing = false;
  private listeners = new Set<() => void>();
  constructor(private deps: Deps) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.record;
  private emit() { this.listeners.forEach((fn) => fn()); }
  /** `expected` closes the cancel race: a queued write for a record that was just discarded is dropped. */
  private save(record: Handoff | null, expected?: Handoff) {
    const op = this.queue.catch(() => {}).then(async () => {
      if (expected && this.snapshot() !== expected) return;
      await this.deps.write(record); this.record = record; if (!record) this.unreadable = null; this.notice = ''; this.emit();
    });
    this.queue = op; return op;
  }
  hydrate() {
    return this.loading ??= this.deps.read().then((saved) => {
      if (saved && (!versionOK(saved.version) || !saved.key || (saved.scope && saved.role !== 'owner') || !['awaiting-app', 'dispatching', 'tracking', 'unknown', 'failed', 'complete'].includes(saved.stage))) {
        // Keep the raw value so "Clear saved update" can discard it; never treat it as a live handoff.
        this.unreadable = saved; this.readFailed = false;
        throw new Error('The saved update cannot be read. No server command was sent.');
      }
      this.unreadable = null; this.readFailed = false;
      this.record = saved; this.loaded = true; this.error = ''; this.notice = ''; this.emit();
    }).catch((e) => {
      this.loading = undefined; this.loaded = true; this.readFailed = true; this.notice = (e as Error).message; this.emit(); throw e;
    });
  }
  /** Selection changes invalidate in-flight authentication/download/preflight, even after switch-back. */
  invalidate() { this.epoch++; }
  async start(update: AppUpdate, visible = () => true) {
    if (this.working) return;
    this.working = true; this.error = ''; this.emit();
    const epoch = ++this.epoch, original = this.deps.context();
    const eligible = () => epoch === this.epoch && visible() && scope(this.deps.context()) === scope(original)
      && (!original.server || this.deps.context().role === original.role);
    try {
      // An unreadable saved handoff must not block a fresh, explicitly consented update. A transient
      // storage failure is retried first so a valid record holding a running job is not overwritten.
      try { await this.hydrate(); } catch {
        try { await this.hydrate(); } catch { /* persistent failure: a fresh consent replaces it */ }
      }
      if (this.record) throw new Error('Finish or cancel the current update first.');
      if (!versionOK(update.version) || !versionOK(original.current) || compareVersions(update.version, original.current) <= 0) throw new Error('Only a newer published release can be installed.');
      if (!update.apk) { await this.deps.install(update, eligible); return; }
      if (!(await this.deps.authenticate('Update Winglet'))) {
        throw new Error('The update needs your approval before it can start. Try again.');
      }
      if (!eligible()) throw new Error('The selected connection changed before the update could start. Try again.');
      const owner = original.role === 'owner' && !!original.server;
      const record: Handoff = { version: update.version, key: this.deps.key(), stage: 'awaiting-app', created: Date.now(),
        ...(owner ? { scope: scope(original), serverName: original.server!.bot.title, role: original.role } : {}),
        message: 'Confirm installation in Android, then reopen Winglet. The server has not been changed.' };
      await this.save(record);
      if (!eligible()) { await this.save(null); return; }
      const result = await this.deps.install(update, eligible);
      if (this.snapshot() !== record) return;
      if (!eligible() || result === 'cancelled') await this.save(null);
      else if (result !== 'opened') await this.save({ ...record, stage: 'failed',
        message: result === 'error'
          ? 'The app update could not be downloaded or opened. The server was not changed.'
          : 'The app update was cancelled. The server was not changed.' });
    } catch (e) { this.error = (e as Error).message; }
    finally { this.working = false; this.emit(); }
  }
  async observe() {
    // Guard re-entrancy without flagging work during hydration, so polling cannot disable the
    // app-offer button or race a second observer into the same consent.
    if (this.working || this.observing) return;
    this.observing = true;
    try {
      try { await this.hydrate(); } catch (e) { this.error = (e as Error).message; this.emit(); return; }
      if (this.working) return;
      const record = this.record;
      if (!record || record.stage === 'failed' || record.stage === 'complete') return;
      this.working = true;
      const epoch = this.epoch;
      try {
        const context = this.deps.context();
        const orphan = !!record.scope && scope(context) !== record.scope;
        let scopeContext = context;
        if (orphan && record.scope) {
          const scopeServer = context.servers?.find((candidate: Server) => scope({ ...context, server: candidate }) === record.scope);
          // Without the saved pairing there is nothing to ask; the host tells the user to reselect it.
          if (!scopeServer) return;
          scopeContext = { ...context, server: scopeServer, role: context.runtime?.[scopeServer.id]?.me?.role };
        }
        const eligible = () => epoch === this.epoch && this.record === record && !orphan
          && scope(scopeContext) === record.scope && scopeContext.role === record.role && record.role === 'owner'
          && scopeContext.online && scopeContext.foreground && !scopeContext.locked;
        if (record.stage === 'awaiting-app') {
          // A consent bound to an unselected pairing is never sent on its own; the host offers to clear it.
          if (orphan) return;
          if (context.current !== record.version) {
            if (versionOK(context.current) && compareVersions(context.current, record.version) > 0) {
              await this.save({ ...record, stage: 'complete', message: 'A different app release is running. The saved server step was cancelled.' }, record);
            }
            return;
          }
          if (!record.scope) { await this.save({ ...record, stage: 'complete', message: `App ${record.version} is running. No server update was authorized.` }, record); return; }
          if (!record.created || Date.now() - record.created > CONSENT_TTL) {
            await this.save({ ...record, stage: 'complete', message: 'The saved update consent expired. No server command was sent.' }, record);
            return;
          }
          if (!eligible()) return;
          const info = await this.deps.system(context.server!);
          if (!eligible()) return;
          if (!versionOK(info.version)) throw new Error('The server version is unknown. No server command was sent.');
          if (compareVersions(info.version, record.version) >= 0) {
            await this.save({ ...record, stage: 'complete', message: info.version === record.version
              ? `App and server are on ${record.version}.` : `App ${record.version} is running. The newer server (${info.version}) was left unchanged.` }, record);
            return;
          }
          // This durable boundary comes BEFORE the network call: a crash here is unknown, never permission to resend.
          const dispatch = { ...record, stage: 'dispatching' as const, message: `App ${record.version} is running. Starting the matching server update…` };
          await this.save(dispatch, record);
          const canSend = () => epoch === this.epoch && this.record === dispatch && scope(this.deps.context()) === record.scope
            && this.deps.context().role === record.role && record.role === 'owner'
            && this.deps.context().online && this.deps.context().foreground && !this.deps.context().locked;
          if (!canSend()) { await this.save({ ...dispatch, stage: 'failed', message: 'The connection or pairing changed. No server command was sent.' }, dispatch); return; }
          let job: Job | null = null;
          let failure: { status?: number; message?: string } | null = null;
          try {
            job = await this.deps.send(context.server!, { target: 'winglet', version: record.version, idempotency_key: record.key }, canSend);
          } catch (e) { failure = e as { status?: number; message?: string }; }
          // A late reply after cancel/switch must not resurrect a discarded handoff.
          if (this.snapshot() !== dispatch) return;
          const interrupted = epoch !== this.epoch;
          if (job) {
            // The job was sent before the pairing changed; link it so the owner can still inspect it.
            await this.save({ ...dispatch, stage: 'tracking', jobId: job.id, message: 'Installing the matching server plugin. Restart waits for idle chats.' }, dispatch);
          } else if (failure) {
            const status = failure.status;
            // 5xx may mean the job was created; treat as unknown. 4xx is a definite failure.
            const isServerError = typeof status === 'number' && status >= 500 && status < 600;
            if (isServerError || interrupted) {
              await this.save({ ...dispatch, stage: 'unknown', message: isServerError
                ? 'The server returned an error; the job may have been created. Checking history.'
                : 'The connection changed during the server step. The result is unknown; no new installation will be sent automatically.' }, dispatch);
            } else if (typeof status === 'number' && status > 0) {
              await this.save({ ...dispatch, stage: 'failed', message: failure.message || 'The server update could not be started.' }, dispatch);
            } else if (status === 0) {
              await this.save({ ...dispatch, stage: 'unknown', message: 'The server reply was lost. Checking history; no new installation will be sent automatically.' }, dispatch);
            } else {
              await this.save({ ...dispatch, stage: 'failed', message: failure.message || 'The server update could not be started.' }, dispatch);
            }
          } else {
            await this.save({ ...dispatch, stage: 'failed', message: interrupted
              ? 'The connection or pairing changed. No server command was sent.'
              : 'The server step was cancelled before sending.' }, dispatch);
          }
        } else if (eligible() || (!!record.jobId && ['dispatching', 'tracking', 'unknown'].includes(record.stage))) {
          if (record.stage === 'dispatching') {
            // An interrupted send on an unselected pairing is left for the user to reselect and inspect.
            if (orphan) return;
            await this.save({ ...record, stage: 'unknown', message: 'The server request was interrupted. Checking history; no new installation will be sent automatically.' }, record);
          }
          const current = this.record;
          if (!current) return;
          const job = await this.deps.recover(scopeContext.server!, current.jobId, current.version, current.created);
          if (this.snapshot() !== current) return;
          if (job) {
            const stage = job.state === 'succeeded' ? 'complete' : job.state === 'failed' ? 'failed' : 'tracking';
            const message = job.state === 'succeeded' ? `App and server are on ${current.version}.`
              : job.state === 'failed' ? (job.detail?.message || 'The server update failed.')
              : 'Installing the matching server plugin. Restart waits for idle chats.';
            // A running job is polled every 2s; do not rewrite an identical tracking record each time.
            if (current.stage !== stage || current.jobId !== job.id || current.message !== message) {
              await this.save({ ...current, stage, jobId: job.id, message }, current);
            }
          } else if (current.jobId && current.stage !== 'unknown') {
            await this.save({ ...current, stage: 'unknown', message: 'The saved server result is unavailable. It may still be running; acknowledging this notice does not cancel it.' }, current);
          }
        }
        // The server answered: whatever restart was in flight is over.
        this.transientSince = 0;
        if (this.notice === RESTART_NOTICE) this.notice = '';
      } catch (e) {
        // The plugin install restarts the gateway, so the first polls after a job starts fail with a
        // 502 from whatever fronts it. That is the update working, not an error to show.
        if (isTransientServerError(e) && this.record && RESTART_STAGES.includes(this.record.stage)) {
          const now = Date.now();
          if (!this.transientSince) this.transientSince = now;
          if (now - this.transientSince < RESTART_PATIENCE) {
            this.error = '';
            this.notice = RESTART_NOTICE;
          } else {
            this.transientSince = 0;
            this.error = 'The server has not answered since the update started. Check that it is running, then tap Check again.';
          }
        } else {
          this.transientSince = 0;
          this.error = (e as Error).message;
        }
      }
      finally { this.working = false; this.emit(); }
    } finally { this.observing = false; }
  }
  clearError() { if (!this.error && !this.notice) return; this.error = ''; this.notice = ''; this.emit(); }
  /**
   * A saved consent is bound to one selected pairing. If that pairing is gone, the app must still
   * be updateable. This clears only a record whose Android consent was never given: once the app
   * is running the consented version, the host treats it as a completed terminal handoff.
   */
  async recoverOrphan() {
    const record = this.record, context = this.deps.context();
    if (!record || record.scope === undefined || scope(context) === record.scope) return;
    // A record whose Android consent was never installed is dead. If the consented version is
    // running, the host still needs it to decide whether the matching server step is required.
    if (context.current === record.version) return;
    this.invalidate(); this.deps.abort();
    try { await this.save(null); this.error = ''; this.emit(); } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
  /**
   * A consent bound to a pairing that is no longer selected can be discarded once the matching app
   * version is running. The server step cannot be resumed without the original pairing, so the
   * notice must not be a dead end.
   */
  async acknowledgeOrphan() {
    const record = this.record, context = this.deps.context();
    if (!record || record.scope === undefined || scope(context) === record.scope) return;
    if (context.current !== record.version) return;
    if (record.scope && context.server && scope({ ...context, server: context.server }) === record.scope) return;
    try { await this.save(null); this.error = ''; this.emit(); } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
  async cancel() {
    if (this.record && !['awaiting-app', 'dispatching', 'tracking', 'unknown'].includes(this.record.stage)) return;
    this.invalidate(); this.deps.abort();
    // Drop the in-memory record synchronously: a queued observer reply must not resurrect it.
    const previous = this.record;
    this.record = null;
    try {
      await this.save(null);
      this.error = ''; this.emit();
    } catch (e) {
      // Restore the previous record so it is not lost; the error surfaces as notice.
      this.record = previous;
      this.error = (e as Error).message; this.emit();
    }
  }
  async done() {
    const context = this.deps.context();
    // Hydrate if we don't have an in-memory record but there might be one on disk.
    if (!this.record) {
      try { await this.hydrate(); } catch { /* no record or unreadable: nothing to do */ }
    }
    const record = this.record;
    if (!record || record.stage === 'awaiting-app' || record.stage === 'dispatching') return;
    // A scoped server record must not be cleared locally before the owner role is known while the
    // server is reachable: doing so leaves the job in the ledger and the ordinary job host re-prompts
    // for it. Offline, the user must still be able to close the notice.
    // Trade-off: offline close skips acknowledge, so the ledger job stays unacknowledged and the
    // ordinary job host may prompt again once the server is back online. Accepted to avoid a dead end.
    if (record.scope && scope(context) === record.scope && context.role === undefined && context.online) return;
    try {
      // Only the owner pairing can acknowledge a server job; everyone can close a local notice.
      if (record.scope && scope(context) === record.scope && context.role === 'owner') {
        await this.deps.acknowledge(context.server!, record);
      }
      await this.save(null); this.error = ''; this.emit();
    } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
  /** Discard an unreadable or hopeless handoff so the app can still be updated. */
  async resetUnreadable() {
    const record = this.record;
    if (!record && !this.unreadable && !this.readFailed) return;
    if (record && ['awaiting-app', 'dispatching', 'tracking'].includes(record.stage)) return;
    try { await this.save(null); this.unreadable = null; this.readFailed = false; this.error = ''; this.notice = ''; this.emit(); } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
}
