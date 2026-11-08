import type { Job, Server } from './types';

export const updateScope = (s: Server) => JSON.stringify([s.parent ?? s.id, s.url, s.deviceId]);
export const mergeJob = (old: Job | undefined, next: Job): Job => {
  if (!old || old.id !== next.id) return next;
  if (old.state !== 'running' && next.state === 'running') return old;
  return next.updated_at >= old.updated_at ? next : old;
};
export type UpdateRecord = { jobs: Job[]; acknowledged: string[]; pending?: Record<string, string>; uncertain?: boolean };
const empty = (): UpdateRecord => ({ jobs: [], acknowledged: [] });
const storageKey = (s: Server) => 'winglet.updateRecovery.' + Array.from(updateScope(s), (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

/** Durable per-pairing results. Network replies merge; they never replace a newer or terminal result. */
export class UpdateRecovery {
  private records = new Map<string, UpdateRecord>();
  private queues = new Map<string, Promise<unknown>>();
  private listeners = new Set<(server: Server) => void>();
  constructor(private deps: {
    read: (key: string) => Promise<UpdateRecord | null>;
    write: (key: string, value: UpdateRecord) => Promise<void>;
    fetch: (server: Server, path: string) => Promise<{ jobs?: Job[]; job?: Job }>;
  }) {}
  subscribe = (listener: (server: Server) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (s: Server): UpdateRecord => this.records.get(updateScope(s)) ?? EMPTY;
  private change(s: Server, mutate: (record: UpdateRecord) => void): Promise<void> {
    const key = updateScope(s);
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const hydrated = this.records.has(key);
      let record = this.records.get(key);
      if (!record) {
        const saved = await this.deps.read(storageKey(s));
        record = saved && Array.isArray(saved.jobs) && Array.isArray(saved.acknowledged) ? saved : empty();
      }
      // Do not publish a change which has not been written durably.
      const next = { ...record, jobs: [...record.jobs], acknowledged: [...record.acknowledged] };
      if (!hydrated && next.pending) next.uncertain = true;
      mutate(next);
      const changed = JSON.stringify(next) !== JSON.stringify(record);
      if (changed) await this.deps.write(storageKey(s), next);
      // Initial hydration publishes once, without rewriting identical durable data.
      if (!hydrated || changed) {
        this.records.set(key, next);
        this.listeners.forEach((listener) => listener(s));
      }
    });
    this.queues.set(key, operation);
    return operation;
  }
  hydrate(s: Server) { return this.change(s, () => {}); }
  begin(s: Server, body: Record<string, string>) {
    return this.change(s, (r) => {
      if (r.pending || r.jobs.some((j) => j.state === 'running')) throw new Error('An update is already being tracked. Check its result first.');
      r.pending = body; r.uncertain = false;
    });
  }
  markUnknown(s: Server) { return this.change(s, (r) => { if (r.pending) r.uncertain = true; }); }
  clearPending(s: Server, requestKey: string) {
    return this.change(s, (r) => {
      if (r.pending?.idempotency_key !== requestKey) return;
      delete r.pending; delete r.uncertain;
    });
  }
  acknowledgeUnknown(s: Server, requestKey: string) {
    return this.change(s, (r) => {
      if (!r.uncertain || r.pending?.idempotency_key !== requestKey) return;
      delete r.pending; delete r.uncertain;
    });
  }
  track(s: Server, job: Job) {
    return this.change(s, (r) => {
      if (job.kind !== 'winglet_update' || job.device_id !== s.deviceId || r.acknowledged.includes(job.id)) return;
      const index = r.jobs.findIndex((old) => old.id === job.id);
      const merged = mergeJob(index < 0 ? undefined : r.jobs[index], job);
      if (index < 0) r.jobs.push(merged); else r.jobs[index] = merged;
    });
  }
  reopen(s: Server, job: Job) {
    return this.change(s, (r) => {
      if (job.kind !== 'winglet_update' || job.device_id !== s.deviceId) return;
      const old = r.jobs.find((j) => j.id === job.id);
      r.acknowledged = r.acknowledged.filter((id) => id !== job.id);
      r.jobs = [mergeJob(old, job), ...r.jobs.filter((j) => j.id !== job.id)];
    });
  }
  acknowledge(s: Server, id: string) {
    return this.change(s, (r) => {
      const job = r.jobs.find((j) => j.id === id);
      if (!job || job.state === 'running') return;
      r.jobs = r.jobs.filter((j) => j.id !== id);
      r.acknowledged.push(id);
      // History supplies no request key: this job cannot acknowledge an unrelated intent.
    });
  }
  async refresh(s: Server) {
    await this.hydrate(s);
    // 0.10.5 already supplies history here. No lookup-by-key endpoint is required.
    let historyError: unknown, observed = false;
    try {
      const history = await this.deps.fetch(s, '/api/system');
      for (const job of history.jobs ?? []) await this.track(s, job);
      observed = true;
    } catch (e) { historyError = e; }
    for (const job of this.snapshot(s).jobs) {
      if (job.state !== 'running') continue;
      try {
        const reply = await this.deps.fetch(s, `/api/jobs/${encodeURIComponent(job.id)}`);
        if (reply.job?.id === job.id) { await this.track(s, reply.job); observed = true; }
      } catch { /* Keep progress visible while the server restarts. */ }
    }
    if (!observed && historyError) throw historyError;
  }
}
const EMPTY: UpdateRecord = { jobs: [], acknowledged: [] };
