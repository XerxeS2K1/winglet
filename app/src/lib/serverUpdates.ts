import { create } from 'zustand';
import { api } from './api';
import type { Server, UpdatesInfo } from './types';

export const serverUpdateKey = (server: Server) => `${server.id}:${server.deviceId}`;

/** Shared preflight results let Check now use the same release. Never persisted. */
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
