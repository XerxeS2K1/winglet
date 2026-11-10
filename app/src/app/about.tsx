import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Text, View } from 'react-native';
import { InstallButton } from '../components/AppUpdate';
import { AgentFace } from '../components/AgentFace';
import { Activity, CircleArrowUp, ExternalLink, FileText, HardDrive, RefreshCw } from '../components/icons';
import { Logo } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Button, Card, Footnote, ListGroup, ListRow, SectionHeader, Toggle } from '../components/ui';
import { agoText } from '../lib/agent';
import { api, signedApi } from '../lib/api';
import { appUpdateSupported, useAppUpdate } from '../lib/appUpdateCheck';
import { checkCacheStatus, getCacheStatus, resetCache, subscribeCacheStatus } from '../lib/cache';
import { usePrefs } from '../lib/prefs';
import { APP_PROTOCOL, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server, ServerInfo, SystemInfo } from '../lib/types';
import { compareVersions } from '../lib/version';

/** Versions on both sides, what to update, and the on-device cache. */
export default function AboutScreen() {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const clearCache = useApp((st) => st.clearCache);
  const [cleared, setCleared] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState(false);
  const cacheStatus = useSyncExternalStore(subscribeCacheStatus, getCacheStatus, getCacheStatus);
  useEffect(() => { void checkCacheStatus(); }, []);
  const appVersion = Constants.expoConfig?.version ?? '';
  return (
    <Screen title="About">
      <View style={s.hero}>
        <Logo size={76} />
        <Text style={s.app}>Winglet</Text>
        <View style={s.pills}>
          {appVersion ? <View style={s.pill}><Text style={s.pillText}>Version {appVersion}</Text></View> : null}
          <View style={s.pill}><Text style={s.pillText}>Open source</Text></View>
        </View>
      </View>
      <Footnote>Not affiliated with Nous Research.</Footnote>

      <SectionHeader title="Your bots" />
      <View style={{ gap: 10 }}>
        {servers.map((srv) => {
          const info = runtime[srv.id]?.info;
          const compat = runtime[srv.id]?.compat;
          const behind = !!info?.version && !!appVersion && compareVersions(info.version, appVersion) < 0;
          return (
            <Card key={srv.id} style={{ gap: t.space.md }}>
              <View style={s.botRow}>
                <AgentFace server={srv} size={44} still />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.botName}>{srv.bot.title}</Text>
                  <ServerVersion server={srv} info={info} />
                </View>
                <Button size="sm" variant="secondary" title="Connection" icon={<Activity size={15} color={t.colors.text} />} onPress={() => router.push(`/connection/${srv.id}`)} />
              </View>
              {compat === 'update-app' ? (
                <Text style={s.warn}>Update this app to connect to {srv.bot.title}.</Text>
              ) : compat === 'update-server' || behind ? (
                <Text style={s.warn}>
                  {compat ? 'Update needed' : 'Update available'}: Winglet is behind.
                </Text>
              ) : null}
            </Card>
          );
        })}
      </View>

      {appUpdateSupported ? (
        <>
          <AppUpdateCard appVersion={appVersion} />
          <ServerAutoUpdateCard />
        </>
      ) : null}

      <SectionHeader title="Storage" />
      <Card style={{ gap: 12 }}>
        {cacheStatus === 'unavailable' ? (
          <>
            <Text style={s.warn} accessibilityRole="alert">Offline storage is unavailable. Offline drafts and unsent messages can't be saved.</Text>
            {confirmReset ? (
              <>
                <Text style={s.note}>Resetting will permanently delete previous offline drafts and unsent messages. This cannot be undone.</Text>
                {resetError ? <Text style={s.warn} accessibilityRole="alert">Couldn't reset offline storage. Please try again.</Text> : null}
                <Button title="Confirm reset offline storage" variant="danger" loading={resetting} onPress={async () => {
                  setResetting(true); setResetError(false);
                  try { await resetCache(); setConfirmReset(false); } catch { setResetError(true); }
                  finally { setResetting(false); }
                }} />
                <Button title="Cancel" variant="secondary" disabled={resetting} onPress={() => { setConfirmReset(false); setResetError(false); }} />
              </>
            ) : <Button title="Reset offline storage" variant="danger" onPress={() => setConfirmReset(true)} />}
          </>
        ) : (
          <>
            <Text style={s.note}>Clearing the offline cache keeps your full history on the server.</Text>
            <Button title={cleared ? 'Cleared' : 'Clear cached messages'} variant="secondary" icon={<HardDrive size={16} color={t.colors.text} />}
              onPress={async () => { await clearCache(); setCleared(true); }} />
          </>
        )}
      </Card>

      <SectionHeader title="Help" />
      <ListGroup>
        <ListRow title="App protocol" value={String(APP_PROTOCOL)} />
        <ListRow icon={<FileText size={18} color={t.colors.textSecondary} />} title="Open-source notices" onPress={() => router.push('/open-source-notices')} />
        <ListRow icon={<ExternalLink size={18} color={t.colors.textSecondary} />} title="Source code & help" onPress={() => Linking.openURL('https://github.com/XerxeS2K1/winglet')} />
      </ListGroup>
    </Screen>
  );
}

/** The server's plugin version and the last time it updated itself, read-only. */
export function ServerVersion({ server, info }: { server: Server; info?: ServerInfo }) {
  const s = useStyles();
  const [system, setSystem] = useState<SystemInfo | null>(null);
  useEffect(() => {
    let alive = true;
    setSystem(null);
    api<SystemInfo>(server, '/api/system')
      .then((next) => { if (alive) setSystem(next); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [server.id, server.url, server.token]);
  const version = system?.version || info?.version;
  const updated = system?.updatedAt;
  return (
    <Text style={s.meta} numberOfLines={2}>
      {version ? `Plugin ${version}` : 'Plugin version unknown'}
      {updated ? ` · updated ${whenText(updated)}` : ' · update time unavailable'}
      {info?.hermes_version ? ` · Hermes ${info.hermes_version}` : ''}
    </Text>
  );
}

/** "09:41" for today, or a short date for an older update. */
function whenText(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value > 1e12 ? value : value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Whether a newer Android app is out, with a single Update action. */
export function AppUpdateCard({ appVersion }: { appVersion: string }) {
  const t = useTheme();
  const s = useStyles();
  const enabled = usePrefs((st) => st.prefs.updateCheck);
  const setPrefs = usePrefs((st) => st.update);
  const { update, checking, checkedAt, failed, check } = useAppUpdate();
  useEffect(() => {
    if (enabled) void check();
  }, [enabled, check]);
  const status = checking ? 'Checking…'
    : update ? `Winglet ${update.version} available`
    : failed ? "Couldn't reach GitHub."
    : checkedAt ? `Up to date (checked ${agoText(checkedAt / 1000)})`
    : enabled ? '' : 'Automatic checks off; releases are on GitHub.';
  return (
    <>
      <SectionHeader title="App updates" />
      <View style={{ gap: 10 }}>
        <Card style={{ gap: 12 }}>
          {status ? <Text style={update ? s.good : s.note}>{status}</Text> : null}
          {update ? (
            <>
              {update.notes ? <Text style={s.note}>{update.notes}</Text> : null}
              <InstallButton update={update} />
              <Button title="What's new" variant="secondary" icon={<ExternalLink size={16} color={t.colors.text} />} onPress={() => Linking.openURL(update.page)} />
            </>
          ) : (
            <Button title="Check now" variant="secondary" loading={checking} icon={<RefreshCw size={16} color={t.colors.text} />} onPress={() => check(true)} />
          )}
        </Card>
        <ListGroup>
          <ListRow icon={<CircleArrowUp size={18} color={t.colors.textSecondary} />} title="Check automatically" value="Twice daily"
            right={<Toggle label="Check for app updates automatically" value={enabled} onValueChange={(on) => setPrefs({ updateCheck: on })} />} />
        </ListGroup>
      </View>
      <Footnote>App updates come from GitHub. The server updates its own plugin; this phone never starts a server update.</Footnote>
    </>
  );
}

/**
 * Owner-only setting. The server reads this itself; the phone writes it and otherwise leaves the
 * server alone. Members do not see the switch because the server would refuse the write.
 */
export function ServerAutoUpdateCard() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((item) => item.id === st.selection.serverId) ?? st.servers[0]);
  const owner = useApp((st) => (server ? st.runtime[server.id]?.me?.role === 'owner' : false));
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!server || !owner) return;
    let alive = true;
    setValue(null);
    setError('');
    api<{ autoUpdate: boolean }>(server, '/api/settings')
      .then((next) => { if (alive) setValue(next.autoUpdate); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [server?.id, server?.url, owner]);
  if (!server || !owner) return null;
  const change = async (on: boolean) => {
    const before = value;
    setValue(on);
    setSaving(true);
    setError('');
    try {
      const next = await signedApi<{ autoUpdate: boolean }>(server, 'PUT', '/api/settings', { autoUpdate: on });
      setValue(next.autoUpdate);
    } catch (e) {
      setValue(before);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionHeader title="Server updates" />
      <ListGroup>
        <ListRow icon={<CircleArrowUp size={18} color={t.colors.textSecondary} />} title="Update automatically"
          value={value === null ? 'Loading…' : value ? 'On' : 'Off'}
          right={value === null ? <Text style={s.note}>Loading…</Text>
            : <Toggle label="Update the server plugin automatically" value={value}
              onValueChange={(on) => { if (!saving) void change(on); }} />} />
      </ListGroup>
      <Footnote>Winglet updates the server plugin by itself when no chat or job is busy. It uses the same backup and rollback as a manual update; the phone is only showing the setting.</Footnote>
      {error ? <Text style={s.warn} accessibilityRole="alert">{error}</Text> : null}
    </>
  );
}

const useStyles = makeStyles((t) => ({
  hero: {
    alignItems: 'center', gap: t.space.sm, marginTop: t.space.lg, paddingVertical: t.space.xl, paddingHorizontal: t.space.lg,
    backgroundColor: t.colors.surface, borderRadius: t.radius.xl, borderWidth: 1, borderColor: t.colors.border,
  },
  app: { ...t.type.title, color: t.colors.text, marginTop: t.space.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.space.sm },
  pill: { paddingHorizontal: t.space.md, paddingVertical: t.space.xs, borderRadius: t.radius.pill, backgroundColor: t.colors.pressed, borderWidth: 1, borderColor: t.colors.border },
  pillText: { ...t.type.caption, color: t.colors.textSecondary },
  meta: { ...t.type.footnote, color: t.colors.textSecondary, marginTop: 2 },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  botName: { ...t.type.bodyStrong, color: t.colors.text },
  warn: { ...t.type.callout, color: t.colors.warning },
  mono: { fontFamily: t.fonts.mono, color: t.colors.text },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  good: { ...t.type.callout, color: t.colors.success },
}));
