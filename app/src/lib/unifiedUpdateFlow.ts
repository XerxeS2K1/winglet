import { create } from 'zustand';
import { useAppInstall } from './appInstall';
import { unlock } from './appLock';
import { useApp } from './store';
import { AppUpdateFlow } from './unifiedUpdate';

/** The one phone-side update flow. It never contacts the server's update endpoints. */
export const appUpdateFlow = new AppUpdateFlow({
  authenticate: unlock,
  install: (update, eligible) => useAppInstall.getState().install(update, eligible),
  lastError: () => useAppInstall.getState().error ?? '',
});

type FlowState = { working: boolean; error: string };

const initial: FlowState = { working: appUpdateFlow.working, error: appUpdateFlow.error };

export const useUnifiedUpdate = create<FlowState>(() => initial);

const sync = () => useUnifiedUpdate.setState({ working: appUpdateFlow.working, error: appUpdateFlow.error });
appUpdateFlow.subscribe(sync);

// A different bot means a different app context. If authorization was still open, it belongs to the old one.
let lastServer = useApp.getState().selection.serverId;
useApp.subscribe((state) => {
  const next = state.selection.serverId;
  if (next === lastServer) return;
  lastServer = next;
  appUpdateFlow.invalidate();
});
