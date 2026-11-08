import { create } from 'zustand';
import { api, ApiError, signedApi } from './api';
import { unlock } from './appLock';
import { idempotencyKey } from './control';
import { updateRecovery } from './updateJobs';
import type { Job, Server, UpdatesInfo } from './types';

export const SERVER_UPDATE_CONSENT = 'Tapping Update server authorizes the pinned Winglet release and its declared Python dependencies. It installs first, then restarts when chats are idle. A backup is made first, with rollback if startup fails.';

export const serverUpdateKey = (server: Server) => `${server.id}:${server.deviceId}`;

/** Shared preflight results let Check now and the startup prompt use the same release. Never persisted. */
export const useServerUpdates = create<{
  byServer: Record<string, UpdatesInfo>;
  publish: (server: Server, updates: UpdatesInfo) => void;
}>((set) => ({
  byServer: {},
  publish: (server, updates) => set((state) => ({ byServer: { ...state.byServer, [serverUpdateKey(server)]: updates } })),
}));
const checks = new Map<string, number>();
export async function checkServerUpdates(server: Server, force = false): Promise<UpdatesInfo> {
  const key = serverUpdateKey(server), check = (checks.get(key) ?? 0) + 1;
  checks.set(key, check);
  const updates = await api<UpdatesInfo>(server, `/api/system/updates${force ? '?force=1' : ''}`);
  if (checks.get(key) === check) useServerUpdates.getState().publish(server, updates);
  return updates;
}

/** Fresh local authentication is mandatory even when the ordinary app lock is disabled. */
export async function updateServerWinglet(server: Server, version?: string | null, eligible = () => true): Promise<Job | null> {
  if (!eligible()) return null;
  const ok = await unlock('Update the server');
  if (!ok || !eligible()) return null;
  return sendConsentedWingletUpdate(server, { target: 'winglet', ...(version ? { version } : {}), idempotency_key: idempotencyKey() }, eligible);
}

/** Internal handoff after explicit authenticated consent. Not a standing unlock bypass or startup permission. */
export async function sendConsentedWingletUpdate(server: Server, body: Record<string, string>, eligible = () => true): Promise<Job | null> {
  if (!eligible()) return null;
  await updateRecovery.begin(server, body);
  if (!eligible()) { await updateRecovery.clearPending(server, body.idempotency_key); return null; }
  const send = () => signedApi<{ job: Job }>(server, 'POST', '/api/system/update', body);
  try {
    // Retry only a lost transport reply, with exactly the same key/payload.
    const result = await send().catch((e) => e instanceof ApiError && e.status === 0 && eligible() ? send() : Promise.reject(e));
    await updateRecovery.track(server, result.job);
    await updateRecovery.clearPending(server, body.idempotency_key);
    return result.job;
  } catch (e) {
    if (e instanceof ApiError && e.data?.job) await updateRecovery.track(server, e.data.job as Job);
    if (e instanceof ApiError && e.status !== 0) await updateRecovery.clearPending(server, body.idempotency_key);
    else await updateRecovery.markUnknown(server);
    // With both replies lost, retain the intent and recover through existing history on reconnect.
    throw e;
  }
}
