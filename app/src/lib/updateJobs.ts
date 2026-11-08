import { create } from 'zustand';
import { api } from './api';
import { cacheGet, cacheSetStrict } from './cache';
import { UpdateRecovery, updateScope, type UpdateRecord } from './updateRecovery';

export { updateScope } from './updateRecovery';
export const useUpdateJobs = create<{ byScope: Record<string, UpdateRecord> }>(() => ({ byScope: {} }));
export const updateRecovery = new UpdateRecovery({
  read: (key) => cacheGet<UpdateRecord | null>(key, null),
  write: cacheSetStrict,
  fetch: (server, path) => api(server, path),
});
updateRecovery.subscribe((server) => {
  useUpdateJobs.setState((state) => ({ byScope: { ...state.byScope, [updateScope(server)]: updateRecovery.snapshot(server) } }));
});
