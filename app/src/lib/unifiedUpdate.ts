import type { AppUpdate } from './appUpdate';
import type { Job, Server } from './types';
import { updateScope } from './updateRecovery';
import { compareVersions } from './version';

type Stage = 'awaiting-app' | 'dispatching' | 'tracking' | 'unknown' | 'failed' | 'complete';
export type Handoff = { version: string; key: string; scope?: string; serverName?: string; role?: string; stage: Stage; message: string; jobId?: string };
export type UpdateContext = { current: string; server?: Server; role?: string; online: boolean; foreground: boolean; locked: boolean };
type Deps = {
  read: () => Promise<Handoff | null>; write: (value: Handoff | null) => Promise<void>;
  context: () => UpdateContext; authenticate: (prompt: string) => Promise<boolean>; key: () => string;
  install: (update: AppUpdate, eligible: () => boolean) => Promise<string>; abort: () => void;
  system: (server: Server) => Promise<{ version: string }>;
  send: (server: Server, body: Record<string, string>, eligible: () => boolean) => Promise<Job | null>;
  recover: (server: Server, jobId?: string) => Promise<Job | undefined>; acknowledge: (server: Server, record: Handoff) => Promise<void>;
};
const versionOK = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const scope = (c: UpdateContext) => c.server ? updateScope(c.server) : undefined;

/** A one-tap, release-bound consent, not a general permission to update servers on startup. */
export class UnifiedUpdate {
  record: Handoff | null = null;
  loaded = false;
  working = false;
  error = '';
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private loading?: Promise<void>;
  private listeners = new Set<() => void>();
  constructor(private deps: Deps) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.record;
  private emit() { this.listeners.forEach((fn) => fn()); }
  private save(record: Handoff | null) {
    const op = this.queue.catch(() => {}).then(async () => {
      await this.deps.write(record); this.record = record; this.emit();
    });
    this.queue = op; return op;
  }
  hydrate() {
    return this.loading ??= this.deps.read().then((saved) => {
      if (saved && (!versionOK(saved.version) || !saved.key || (saved.scope && saved.role !== 'owner') || !['awaiting-app', 'dispatching', 'tracking', 'unknown', 'failed', 'complete'].includes(saved.stage))) {
        throw new Error('The saved update cannot be read. No server command was sent.');
      }
      this.record = saved; this.loaded = true; this.emit();
    }).catch((e) => { this.loading = undefined; throw e; });
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
      await this.hydrate();
      if (this.record) throw new Error('Finish or cancel the current update first.');
      if (!versionOK(update.version) || !versionOK(original.current) || compareVersions(update.version, original.current) <= 0) throw new Error('Only a newer published release can be installed.');
      if (!update.apk) { await this.deps.install(update, eligible); return; }
      if (!(await this.deps.authenticate('Update Winglet')) || !eligible()) return;
      const owner = original.role === 'owner' && !!original.server;
      const record: Handoff = { version: update.version, key: this.deps.key(), stage: 'awaiting-app',
        ...(owner ? { scope: scope(original), serverName: original.server!.bot.title, role: original.role } : {}),
        message: 'Confirm installation in Android, then reopen Winglet. The server has not been changed.' };
      await this.save(record);
      if (!eligible()) { await this.save(null); return; }
      const result = await this.deps.install(update, eligible);
      if (this.snapshot() !== record) return;
      if (!eligible() || result === 'cancelled') await this.save(null);
      else if (result !== 'opened') await this.save({ ...record, stage: 'failed', message: 'The app installer could not be opened. The server was not changed.' });
    } catch (e) { this.error = (e as Error).message; }
    finally { this.working = false; this.emit(); }
  }
  async observe() {
    if (this.working) return;
    this.working = true;
    const epoch = this.epoch;
    try {
      await this.hydrate();
      const record = this.record, context = this.deps.context();
      if (!record || record.stage === 'failed' || record.stage === 'complete') return;
      const eligible = () => epoch === this.epoch && this.record === record && scope(this.deps.context()) === record.scope
        && this.deps.context().role === record.role && record.role === 'owner'
        && this.deps.context().online && this.deps.context().foreground && !this.deps.context().locked;
      if (record.stage === 'awaiting-app') {
        if (context.current !== record.version) {
          if (versionOK(context.current) && compareVersions(context.current, record.version) > 0) {
            await this.save({ ...record, stage: 'complete', message: 'A different app release is running. The saved server step was cancelled.' });
          }
          return;
        }
        if (!record.scope) { await this.save({ ...record, stage: 'complete', message: `App ${record.version} is running. No server update was authorized.` }); return; }
        if (!eligible()) return;
        const info = await this.deps.system(context.server!);
        if (!eligible()) return;
        if (!versionOK(info.version)) throw new Error('The server version is unknown. No server command was sent.');
        if (compareVersions(info.version, record.version) >= 0) {
          await this.save({ ...record, stage: 'complete', message: info.version === record.version
            ? `App and server are on ${record.version}.` : `App ${record.version} is running. The newer server (${info.version}) was left unchanged.` });
          return;
        }
        // This durable boundary comes BEFORE the network call: a crash here is unknown, never permission to resend.
        const dispatch = { ...record, stage: 'dispatching' as const, message: `App ${record.version} is running. Starting the matching server update…` };
        await this.save(dispatch);
        const canSend = () => epoch === this.epoch && this.record === dispatch && scope(this.deps.context()) === record.scope
          && this.deps.context().role === record.role && record.role === 'owner'
          && this.deps.context().online && this.deps.context().foreground && !this.deps.context().locked;
        if (!canSend()) { await this.save({ ...dispatch, stage: 'failed', message: 'The connection or pairing changed. No server command was sent.' }); return; }
        try {
          const job = await this.deps.send(context.server!, { target: 'winglet', version: record.version, idempotency_key: record.key }, canSend);
          await this.save(job ? { ...dispatch, stage: 'tracking', jobId: job.id, message: 'Installing the matching server plugin. Restart waits for idle chats.' }
            : { ...dispatch, stage: 'failed', message: 'The server step was cancelled before sending.' });
        } catch (e) {
          const status = (e as { status?: number }).status;
          await this.save({ ...dispatch, stage: typeof status === 'number' && status > 0 ? 'failed' : 'unknown',
            message: typeof status === 'number' && status > 0 ? (e as Error).message : 'The server reply was lost. Checking history; no new installation will be sent automatically.' });
        }
      } else if (eligible()) {
        if (record.stage === 'dispatching') await this.save({ ...record, stage: 'unknown', message: 'The server request was interrupted. Checking history; no new installation will be sent automatically.' });
        const job = await this.deps.recover(context.server!, record.jobId);
        if (this.snapshot() === record && record.jobId && !job && record.stage !== 'unknown') {
          await this.save({ ...record, stage: 'unknown', message: 'The saved server result is unavailable. It may still be running; acknowledging this notice does not cancel it.' });
        }
      }
    } catch (e) { this.error = (e as Error).message; }
    finally { this.working = false; this.emit(); }
  }
  async cancel() {
    if (this.record && !['awaiting-app', 'failed', 'complete'].includes(this.record.stage)) return;
    this.invalidate(); this.deps.abort();
    try { await this.save(null); } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
  async done() {
    const record = this.record, context = this.deps.context();
    if (!record || record.stage === 'awaiting-app' || record.stage === 'dispatching') return;
    try {
      if (record.scope) {
        if (scope(context) !== record.scope || context.role !== 'owner') return;
        await this.deps.acknowledge(context.server!, record);
      }
      await this.save(null);
    } catch (e) { this.error = (e as Error).message; this.emit(); }
  }
}
