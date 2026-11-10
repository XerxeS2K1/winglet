import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { AppUpdate } from '../lib/appUpdate';
import { useAppInstall } from '../lib/appInstall';
import { appUpdateSupported, useAppUpdate } from '../lib/appUpdateCheck';
import { compareVersions } from '../lib/version';
import { useLock } from '../lib/appLock';
import { usePrefs } from '../lib/prefs';
import { appUpdateFlow, useUnifiedUpdate } from '../lib/unifiedUpdateFlow';
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
 * time, "Skip this version" waits for the one after. The server is not involved.
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
  // Unmount the native modal immediately when locked; Sheet otherwise animates closed over the lock.
  // Stale offer: once Android has installed the release the process can still be the old build, so the
  // sheet used to say "0.10.10 is out. You have 0.10.9" on a phone that already had 0.10.10.
  const running = Constants.expoConfig?.version ?? '';
  const stale = !!update && !!running && compareVersions(update.version, running) <= 0;
  if (!appUpdateSupported || !enabled || !update || stale || skipped === undefined || locked) return null;
  const visible = update.version !== skipped && !putOff.has(update.version);
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

/** Downloads and installs the app update, showing progress; falls back to the release page. */
export function InstallButton({ update }: { update?: AppUpdate | null }) {
  const t = useTheme();
  const s = useStyles();
  const state = useUnifiedUpdate((st) => st);
  const downloading = useAppInstall((st) => st.phase === 'downloading');
  const progress = useAppInstall((st) => st.progress);
  // Same stale-offer rule as the sheet: a release this build already has is not an update.
  const running = Constants.expoConfig?.version ?? '';
  const offer = update && (!running || compareVersions(update.version, running) > 0) ? update : null;
  if (!offer) return null;
  const start = async () => {
    const outcome = await appUpdateFlow.start(offer);
    // Handed to Android (or the release page opened): stop advertising it. A cancelled installer keeps it.
    if (outcome === 'opened' || outcome === 'browser') useAppUpdate.getState().forget();
  };
  return <View style={{ gap: 8 }}>
    {state.error ? <Text style={s.error} accessibilityRole="alert">{state.error}</Text> : null}
    {downloading && progress !== null ? (
      <View style={s.track}><View style={[s.fill, { width: `${Math.round(progress * 100)}%` }]} /></View>
    ) : null}
    <Button title={offer.apk ? `Update to ${offer.version}` : 'View release'} loading={downloading || state.working}
      disabled={downloading || state.working}
      icon={offer.apk ? <Download size={16} color={t.colors.onAccent} /> : <CircleArrowUp size={16} color={t.colors.onAccent} />}
      onPress={() => start()} />
    <Text style={s.caption}>{offer.apk
      ? 'Downloads the Android app and opens Android\'s installer. Nothing on the server is updated.'
      : 'Opens the release page in your browser. Nothing on the server is updated.'}</Text>
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
