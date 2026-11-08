import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ApiError } from '../lib/api';
import { useLock } from '../lib/appLock';
import { SERVER_UPDATE_CONSENT, checkServerUpdates, serverUpdateKey, updateServerWinglet, useServerUpdates } from '../lib/serverUpdates';
import { usePrefs } from '../lib/prefs';
import { getJSON, setJSON } from '../lib/storage';
import { useApp, useServerState } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { router, usePathname } from 'expo-router';
import type { Server } from '../lib/types';
import { useUpdateJobs, updateScope } from '../lib/updateJobs';
import { Sheet } from './Sheet';
import { Button } from './ui';

/** Per paired device/server and version; Later resets only when the app process starts again. */
const putOff = new Set<string>();

export function ServerUpdatePrompt() {
  const pathname = usePathname();
  const server = useApp((st) => st.servers.find((s) => s.id === st.selection.serverId) ?? st.servers[0]);
  const rt = useServerState(server?.id);
  if (!server || rt?.me?.role !== 'owner') return null;
  if (pathname === '/pair' || pathname === '/scan') return null;
  return <ServerPrompt key={serverUpdateKey(server)} server={server} />;
}

/** Keyed by pairing so late authentication/network responses cannot act on a newly selected server. */
export function ServerPrompt({ server }: { server: Server }) {
  const s = useStyles();
  const rt = useServerState(server.id);
  const locked = useLock((state) => state.locked);
  const autoUpdate = usePrefs((st) => st.prefs.autoUpdateServer);
  const updates = useServerUpdates((state) => state.byServer[serverUpdateKey(server)]);
  const [skipped, setSkipped] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const tracking = useUpdateJobs((state) => state.byScope[updateScope(server)]);
  const [, rerender] = useState(0);
  const active = useRef(true);
  const sending = useRef(false);
  const scope = serverUpdateKey(server);
  const skipKey = `winglet.serverUpdate.skip.${scope}`;
  useEffect(() => {
    active.current = true;
    getJSON<string | null>(skipKey, null).catch(() => null).then((value) => { if (active.current) setSkipped(value); });
    return () => { active.current = false; };
  }, [skipKey]);
  useEffect(() => {
    if (rt?.status === 'online') void checkServerUpdates(server).catch(() => undefined);
  }, [server, rt?.status]);
  const w = updates?.winglet;
  const release = w?.latest_release;
  const version = release?.version;
  const runKey = `${scope}:${version}`;
  const eligible = () => {
    const state = useApp.getState();
    const selected = state.servers.find((item) => item.id === state.selection.serverId) ?? state.servers[0];
    return active.current && !!selected && serverUpdateKey(selected) === scope && selected.url === server.url
      && state.runtime[server.id]?.me?.role === 'owner';
  };
  const later = () => { putOff.add(runKey); rerender((n) => n + 1); };
  const skip = async () => {
    if (!version) return;
    try { await setJSON(skipKey, version); if (active.current) { setSkipped(version); later(); } }
    catch (e) { if (active.current) setError((e as Error).message); }
  };
  const start = async (skipUnlock = false) => {
    if (sending.current || !version || w?.requires_hermes_ok === false || !eligible()) return;
    sending.current = true; setStarting(true); setError('');
    try {
      const next = await updateServerWinglet(server, version, eligible, { skipUnlock });
      if (next && eligible()) later();
    } catch (e) {
      if (active.current) {
        setError((e as Error).message);
        useApp.getState().toast({ serverId: server.id, title: "Couldn't update the server", body: (e as Error).message });
        if (e instanceof ApiError && e.status === 409 && e.data?.job) later();
      }
    } finally { sending.current = false; if (active.current) setStarting(false); }
  };
  const available = !tracking?.pending && !tracking?.jobs.length && rt?.me?.role === 'owner'
    && w?.update_available === true && !!release && w?.requires_hermes_ok !== false;
  // The owner's auto-update setting: install a release as soon as it appears, without a tap or prompt.
  const startRef = useRef(start);
  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => {
    if (autoUpdate && available) void startRef.current(true);
  }, [autoUpdate, available, version]);
  const visible = available && !autoUpdate && !locked && skipped !== undefined && version !== skipped && !putOff.has(runKey);
  return <>
    <Sheet visible={visible} onClose={later} title="Update the server?" scrollable>
      <View style={s.body}>
        <Text style={s.lead}>Server plugin {w?.current ?? w?.version} → {version}</Text>
        {release?.notes ? <Text style={s.notes} numberOfLines={6}>{release.notes}</Text> : null}
        <Text style={s.notes}>{SERVER_UPDATE_CONSENT}</Text>
        {w?.busy?.bots.length ? <Text style={s.warning}>Bots are busy: {w.busy.bots.map((bot) => `${bot.bot}: ${bot.state}${bot.queued ? ` (${bot.queued} queued)` : ''}`).join(', ')}. You can still update.</Text> : null}
        {w?.busy?.unknown ? <Text style={s.warning}>The server couldn't tell whether all bots are idle. You can still update.</Text> : null}
        {w?.requires_hermes_ok === false ? <Text style={s.warning}>Hermes is too old for this release. Update Hermes first ({release?.requires_hermes}).</Text>
          : <Button title="Update server" loading={starting} disabled={starting || rt?.status !== 'online'} onPress={start} />}
        {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
        <Button title="Later" variant="secondary" onPress={later} />
        <Button title="Skip this version" variant="ghost" onPress={skip} />
      </View>
    </Sheet>
  </>;
}

const useStyles = makeStyles((t) => ({
  body: { gap: t.space.md, paddingHorizontal: t.space.xs },
  lead: { ...t.type.bodyStrong, color: t.colors.text },
  notes: { ...t.type.callout, color: t.colors.textSecondary },
  warning: { ...t.type.callout, color: t.colors.warning },
  error: { ...t.type.callout, color: t.colors.danger },
}));
