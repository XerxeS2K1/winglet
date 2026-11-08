import Constants from 'expo-constants';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { usePathname } from 'expo-router';
import { appUpdateSupported } from '../lib/appUpdateCheck';
import { useAppInstall } from '../lib/appInstall';
import { useLock } from '../lib/appLock';
import { useApp, useServerState } from '../lib/store';
import { useUpdateJobs, updateScope } from '../lib/updateJobs';
import { unifiedUpdate, useUnifiedUpdate } from '../lib/unifiedUpdateFlow';
import { makeStyles } from '../lib/themeContext';
import { JobSheet } from './JobSheet';
import { Sheet } from './Sheet';
import { Button } from './ui';

/** The one app+plugin handoff host; the ordinary job host yields only this pairing. */
export function UnifiedUpdateHost() {
  const s = useStyles(), pathname = usePathname();
  const { record, error, loaded } = useUnifiedUpdate();
  const server = useApp((state) => state.servers.find((item) => item.id === state.selection.serverId) ?? state.servers[0]);
  const foreground = useApp((state) => state.foreground);
  const rt = useServerState(server?.id), locked = useLock((state) => state.locked);
  const jobs = useUpdateJobs((state) => server ? state.byScope[updateScope(server)] : undefined);
  const installer = useAppInstall();
  const savedJob = record?.jobId ? jobs?.jobs.find((item) => item.id === record.jobId) : undefined;
  const polling = !!record && ['dispatching', 'tracking', 'unknown'].includes(record.stage);
  useEffect(() => {
    // A consent written before its Android approval belongs to one selected pairing. Once a different
    // app release is actually running, that stale pairing is irrelevant; clear it before the app offer.
    const saved = unifiedUpdate.record, current = server ? updateScope(server) : undefined;
    if (saved?.scope && current && current !== saved.scope && Constants.expoConfig?.version !== saved.version) {
      void unifiedUpdate.recoverOrphan();
    }
  }, [server, record?.key, record?.stage]);
  useEffect(() => {
    if (!appUpdateSupported || locked || !foreground || pathname === '/pair' || pathname === '/scan') return;
    void unifiedUpdate.observe();
    const timer = polling ? setInterval(() => { void unifiedUpdate.observe(); }, 2000) : undefined;
    return () => { if (timer !== undefined) clearInterval(timer); };
  }, [server, rt?.status, rt?.me?.role, foreground, locked, pathname, record?.key, record?.stage, polling]);
  if (!appUpdateSupported || locked || pathname === '/pair' || pathname === '/scan') return null;
  if (!loaded) return null;
  if (!record) return error ? <Sheet visible dismissible onClose={() => unifiedUpdate.clearError()} title="Update unavailable">
    <Text style={s.error}>{error}</Text>
    <Button title="Check again" onPress={() => { unifiedUpdate.clearError(); void unifiedUpdate.observe(); }} />
    <Button title="Clear saved update" variant="secondary" onPress={() => unifiedUpdate.resetUnreadable()} />
  </Sheet> : null;
  const orphan = !!record.scope && (!server || record.scope !== updateScope(server));
  const owner = !record.scope || rt?.me?.role === 'owner';
  const runningVersion = Constants.expoConfig?.version === record.version;
  const job = owner && record.jobId ? jobs?.jobs.find((item) => item.id === record.jobId) : undefined;
  if (orphan && job && record.stage !== 'complete' && record.stage !== 'failed') {
    return <JobSheet managed server={server!} job={job} notice={error || (job.state === 'succeeded' ? `App ${record.version} is running.` : undefined)}
      onClose={() => unifiedUpdate.done()} />;
  }
  if (orphan) {
    const started = ['dispatching', 'tracking', 'unknown'].includes(record.stage);
    return <Sheet visible dismissible={false} onClose={() => {}} title={`Winglet ${record.version} update`}>
      <View style={s.body}>
        <Text style={s.copy}>This saved update belongs to {record.serverName ? `${record.serverName} ` : ''}a connection that is no longer selected.</Text>
        <Text style={s.copy}>{started
          ? 'The server step may still be running. Select that connection again to see its result.'
          : 'The server step was not started.'}</Text>
        {runningVersion
          ? <Button title="Clear saved update" variant="secondary" onPress={() => unifiedUpdate.acknowledgeOrphan()} />
          : <Button title="Clear saved update" variant="secondary" onPress={() => unifiedUpdate.recoverOrphan()} />}
      </View>
    </Sheet>;
  }
  if (job && record.stage !== 'complete' && record.stage !== 'failed') return <JobSheet managed server={server!} job={job}
    notice={error || (job.state === 'succeeded' ? `App ${record.version} is running.` : undefined)}
    onClose={() => unifiedUpdate.done()} />;
  return <Sheet visible dismissible={false} onClose={() => {}} title={`Winglet ${record.version} update`}>
    <View style={s.body}>
      <Text style={s.copy}>{owner ? record.message : 'The server step is waiting for its owner connection. No new command will be sent.'}</Text>
      {record.stage === 'unknown' ? <Text style={s.copy}>A server update may still be running. Acknowledging this notice does not cancel it.</Text> : null}
      {record.serverName ? <Text style={s.copy}>Server: {record.serverName}</Text> : null}
      {installer.phase === 'downloading' ? <Text style={s.copy}>Downloading app{installer.progress === null ? '…' : ` ${Math.round(installer.progress * 100)}%`}</Text> : null}
      {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
      {record.stage === 'awaiting-app' ? <>
        <Text style={s.copy}>Android decides whether to install. Cancelling here also cancels the later server step.</Text>
        <Button title="Cancel update" variant="secondary" onPress={() => unifiedUpdate.cancel()} />
      </> : <>
        <Button title="Check again" variant="secondary" onPress={() => unifiedUpdate.observe()} />
        {['failed', 'complete', 'unknown'].includes(record.stage) ? <Button title={record.stage === 'unknown' ? 'Acknowledge unknown result' : 'Done'} disabled={!owner} onPress={() => unifiedUpdate.done()} /> : null}
        {!['awaiting-app', 'dispatching', 'tracking', 'unknown'].includes(record.stage) ? null : <Button title="Cancel update" variant="secondary" onPress={() => unifiedUpdate.cancel()} />}
      </>}
    </View>
  </Sheet>;
}
const useStyles = makeStyles((t) => ({ body: { gap: t.space.md }, copy: { ...t.type.callout, color: t.colors.textSecondary }, error: { ...t.type.callout, color: t.colors.danger } }));
