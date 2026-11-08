import { useEffect, useState } from 'react';
import { useUnifiedUpdate } from '../lib/unifiedUpdateFlow';
import { Text, View } from 'react-native';
import { usePathname } from 'expo-router';
import { updateRecovery, updateScope, useUpdateJobs } from '../lib/updateJobs';
import { useApp, useServerState } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { JobSheet } from './JobSheet';
import { Sheet } from './Sheet';
import { Button } from './ui';
import type { Server } from '../lib/types';

/** One host for plugin updates, independent of the offer and any retained Server screen. */
export function UpdateJobHost() {
  const pathname = usePathname();
  const server = useApp((s) => s.servers.find((v) => v.id === s.selection.serverId) ?? s.servers[0]);
  const rt = useServerState(server?.id);
  const unified = useUnifiedUpdate((state) => state);
  if (!unified.loaded || (server && unified.record?.scope === updateScope(server))) return null;
  if (!server || rt?.me?.role !== 'owner' || pathname === '/pair' || pathname === '/scan') return null;
  return <PairingUpdateJobs key={updateScope(server)} server={server} />;
}

const useStyles = makeStyles((t) => ({
  body: { gap: t.space.md },
  copy: { ...t.type.callout, color: t.colors.text },
  error: { ...t.type.callout, color: t.colors.danger },
}));

export function PairingUpdateJobs({ server }: { server: Server }) {
  const s = useStyles();
  const record = useUpdateJobs((s) => s.byScope[updateScope(server)]);
  const rt = useServerState(server.id);
  const [error, setError] = useState('');
  const watching = !!record?.pending || !!record?.jobs.some((job) => job.state === 'running');
  const refresh = () => updateRecovery.refresh(server).catch((e) => setError((e as Error).message));
  useEffect(() => {
    let active = true, checking = false;
    const check = async () => {
      if (!active || checking) return;
      checking = true;
      try { await updateRecovery.refresh(server); if (active) setError(''); }
      catch (e) { if (active) setError((e as Error).message); }
      finally { checking = false; }
    };
    // One observation on mount/reconnect; only unresolved work needs a recurring poll.
    void check();
    const timer = watching ? setInterval(check, 2000) : undefined;
    return () => { active = false; if (timer !== undefined) clearInterval(timer); };
  }, [server, rt?.status, watching]);
  // Treat socket/replay as another observation, never an authoritative replacement for a terminal result.
  useEffect(() => {
    if (rt?.job) void updateRecovery.track(server, rt.job).catch((e) => setError((e as Error).message));
  }, [server, rt?.job]);
  const job = record?.jobs[0];
  if (!record?.pending) return job ? <JobSheet key={`${updateScope(server)}:${job.id}`} managed server={server} job={job} notice={error}
    onClose={() => updateRecovery.acknowledge(server, job.id).catch((e) => setError((e as Error).message))} /> : null;
  return <Sheet visible dismissible={false} onClose={() => {}} title="Server plugin update">
    <View style={s.body}>
      <Text style={s.copy}>The update request has no confirmed result yet. Checking the server's job history; do not start another update.</Text>
      {record.jobs.length ? <Text style={s.copy}>Other saved update results remain separate from this unconfirmed request.</Text> : null}
      {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
      <Button title="Check again" onPress={refresh} />
      {record.uncertain ? <Button title="Acknowledge unknown result" variant="secondary" onPress={() => updateRecovery.acknowledgeUnknown(server, record.pending!.idempotency_key).catch((e) => setError((e as Error).message))} /> : null}
    </View>
  </Sheet>;
}
