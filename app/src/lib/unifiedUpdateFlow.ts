import Constants from 'expo-constants';
import { create } from 'zustand';
import { api } from './api';
import { useAppInstall } from './appInstall';
import { appUpdateSupported } from './appUpdateCheck';
import { unlock, useLock } from './appLock';
import { cacheGetStrict, cacheSetStrict } from './cache';
import { idempotencyKey } from './control';
import { sendConsentedWingletUpdate } from './serverUpdates';
import { useApp } from './store';
import { updateRecovery, updateScope } from './updateJobs';
import type { Job } from './types';
import { UnifiedUpdate, type Handoff, type UpdateContext } from './unifiedUpdate';

const KEY = 'winglet.unifiedUpdate.v1';
export function updateContext(): UpdateContext {
  const state = useApp.getState();
  const server = state.servers.find((s) => s.id === state.selection.serverId) ?? state.servers[0];
  return { current: Constants.expoConfig?.version ?? '', server, servers: state.servers, runtime: state.runtime,
    role: server ? state.runtime[server.id]?.me?.role : undefined,
    online: !!server && state.runtime[server.id]?.status === 'online', foreground: state.foreground, locked: useLock.getState().locked };
}
export const unifiedUpdate = new UnifiedUpdate({
  read: () => cacheGetStrict<Handoff | null>(KEY, null), write: (record) => cacheSetStrict(KEY, record),
  context: updateContext, authenticate: unlock, key: idempotencyKey,
  install: (update, eligible) => useAppInstall.getState().install(update, eligible), abort: () => useAppInstall.getState().cancel(),
  system: (server) => api(server, '/api/system'), send: sendConsentedWingletUpdate,
  recover: async (server, jobId, version, created) => {
    await updateRecovery.hydrate(server);
    // A saved handoff ID can outlive the in-memory ledger and the bounded history window.
    if (jobId && !updateRecovery.snapshot(server).jobs.some((job) => job.id === jobId)) {
      try {
        const reply = await api<{ job?: Job }>(server, `/api/jobs/${encodeURIComponent(jobId)}`);
        if (reply.job?.id === jobId) await updateRecovery.track(server, reply.job);
      } catch { /* Keep an explicit unknown result when the exact job cannot be recovered. */ }
    }
    await updateRecovery.refresh(server);
    const jobs = updateRecovery.snapshot(server).jobs;
    if (jobId) return jobs.find((job) => job.id === jobId);
    // No job ID survived (an interrupted send). History still names the exact release job.
    // The server stamps created_at in seconds; the saved consent uses Date.now() in milliseconds.
    const candidates = jobs.filter((job) => job.kind === 'winglet_update' && job.device_id === server.deviceId
      && (!version || job.detail?.to === version)
      && (!created || job.created_at * 1000 >= created));
    return candidates.sort((a, b) => b.updated_at - a.updated_at)[0];
  },
  acknowledge: async (server, record) => {
    await updateRecovery.hydrate(server);
    const state = updateRecovery.snapshot(server), job = state.jobs.find((j) => j.id === record.jobId);
    if (job?.state === 'running' || (record.jobId && !job && record.stage !== 'unknown')) throw new Error('The server update has no terminal result yet. Check again.');
    if (job) await updateRecovery.acknowledge(server, job.id);
    if (state.pending?.idempotency_key === record.key) {
      await updateRecovery.markUnknown(server);
      await updateRecovery.acknowledgeUnknown(server, record.key);
    }
  },
});
export const useUnifiedUpdate = create<{ record: Handoff | null; loaded: boolean; working: boolean; error: string; notice: string }>(() => ({
  record: null, loaded: !appUpdateSupported, working: false, error: '', notice: '',
}));
unifiedUpdate.subscribe(() => useUnifiedUpdate.setState({ record: unifiedUpdate.record, loaded: unifiedUpdate.loaded, working: unifiedUpdate.working, error: unifiedUpdate.error, notice: unifiedUpdate.notice }));
// Invalidate pending authentication/download/preflight on every pairing or role transition, including switch-back.
const signature = () => { const c = updateContext(); return JSON.stringify([c.server ? updateScope(c.server) : null, c.role]); };
let previous = signature();
useApp.subscribe(() => { const next = signature(); if (next !== previous) { previous = next; unifiedUpdate.invalidate(); } });
