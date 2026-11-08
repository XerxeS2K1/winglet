import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { AppUpdate } from '../lib/appUpdate';
import { useAppInstall } from '../lib/appInstall';
import { appUpdateSupported, useAppUpdate } from '../lib/appUpdateCheck';
import { useLock } from '../lib/appLock';
import { usePrefs } from '../lib/prefs';
import { useApp, useServerState } from '../lib/store';
import { unifiedUpdate, useUnifiedUpdate, updateContext } from '../lib/unifiedUpdateFlow';
import { updateScope } from '../lib/updateJobs';
import { getJSON, setJSON } from '../lib/storage';
import { makeStyles, useTheme } from '../lib/themeContext';
import { CircleArrowUp, Download } from './icons';
import { Sheet } from './Sheet';
import { Button } from './ui';

const SKIP_KEY = 'winglet.appUpdate.skip';
/** Versions put off with "Later" since the app started: asked again on the next start, not before. */
const putOff = new Set<string>();

/**
 * Asks once per start when a newer Android app is out. Never required: "Later" asks again next
 * time, "Skip this version" waits for the one after.
 */
export function UpdatePrompt() {
  const s = useStyles();
  const enabled = usePrefs((st) => st.prefs.updateCheck);
  const update = useAppUpdate((st) => st.update);
  const locked = useLock((st) => st.locked);
  const downloading = useAppInstall((st) => st.phase === 'downloading');
  const unified = useUnifiedUpdate((st) => st);
  const busy = downloading || unified.working;
  const [skipped, setSkipped] = useState<string | null | undefined>(undefined);
  const [, rerender] = useState(0);
  useEffect(() => {
    getJSON<string | null>(SKIP_KEY, null).catch(() => null).then(setSkipped);
  }, []);
  useEffect(() => {
    // Once this phone is running a different release, a consent for an older unselected pairing is
    // stale. Clear it so the current app offer is not suppressed by a dead handoff.
    const saved = unifiedUpdate.record, current = updateContext();
    const scope = current.server ? updateScope(current.server) : undefined;
    if (saved?.scope && scope && scope !== saved.scope && Constants.expoConfig?.version !== saved.version) {
      void unifiedUpdate.recoverOrphan();
    }
  }, [unified.record?.key, unified.record?.stage]);
  // Unmount the native modal immediately when locked; Sheet otherwise animates closed over the lock.
  if (!appUpdateSupported || !enabled || !update || skipped === undefined || locked || !unified.loaded || unified.record) return null;
  const visible = update.version !== skipped && !putOff.has(update.version);
  // The shared handoff host takes over once the one-tap consent is persisted.
  const later = () => {
    putOff.add(update.version);
    rerender((n) => n + 1);
  };
  const skip = () => {
    setSkipped(update.version);
    setJSON(SKIP_KEY, update.version).catch(() => undefined);
    later();
  };
  return (
    <Sheet visible={visible} dismissible={!busy} onClose={later} title="Update available">
      <View style={s.body}>
        <Text style={s.lead}>Winglet {update.version} is out. You have {Constants.expoConfig?.version}.</Text>
        {update.notes ? <Text style={s.notes} numberOfLines={6}>{update.notes}</Text> : null}
        <InstallButton update={update} />
        {busy ? null : (
          <>
            <Button title="Later" variant="secondary" onPress={later} />
            <Button title="Skip this version" variant="ghost" onPress={skip} />
          </>
        )}
      </View>
    </Sheet>
  );
}

/** Downloads and installs the update, showing progress; falls back to the release page. */
export function InstallButton({ update }: { update: AppUpdate }) {
  const t = useTheme();
  const s = useStyles();
  const state = useUnifiedUpdate((st) => st);
  const server = useApp((st) => st.servers.find((item) => item.id === st.selection.serverId) ?? st.servers[0]);
  const rt = useServerState(server?.id);
  const offeredScope = server ? updateScope(server) : undefined;
  const role = rt?.me?.role;
  const eligible = () => { const current = updateContext(); return (current.server ? updateScope(current.server) : undefined) === offeredScope && current.role === role; };
  if (state.record) return <Text style={s.caption}>Update {state.record.version}: {state.record.message}</Text>;
  const consent = update.apk && server && role === 'owner'
    ? `Update this app and ${server.bot.title}'s server plugin to ${update.version}, including its declared Python dependencies. Confirm the app in Android, then reopen Winglet; the server restarts when chats are idle.`
    : update.apk ? 'Update this app in Android. No server update is authorized without an owner connection.' : 'Open the release page. No server update will be started.';
  return <View style={{ gap: 8 }}>
    <Button title={update.apk ? `Update to ${update.version}` : 'View release'} loading={state.working} disabled={state.working || !state.loaded}
      icon={update.apk ? <Download size={16} color={t.colors.onAccent} /> : <CircleArrowUp size={16} color={t.colors.onAccent} />}
      onPress={() => unifiedUpdate.start(update, eligible)} />
    <Text style={s.caption}>{consent}</Text>
  </View>;
}

const useStyles = makeStyles((t) => ({
  body: { gap: 12, paddingHorizontal: 4 },
  lead: { ...t.type.bodyStrong, color: t.colors.text },
  notes: { ...t.type.callout, color: t.colors.textSecondary },
  caption: { ...t.type.caption, color: t.colors.textSecondary, textAlign: 'center' },
  error: { ...t.type.callout, color: t.colors.danger },
  inlineLink: { color: t.colors.accent, textDecorationLine: 'underline' },
  track: { height: 8, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  fill: { height: 8, borderRadius: t.radius.pill, backgroundColor: t.colors.accentFill },
}));
