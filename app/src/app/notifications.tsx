import { EncryptedPushSettings } from '../features/encrypted-push/Settings';
import { pushNative } from '../features/encrypted-push/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { AgentFace } from '../components/AgentFace';
import { BellOff, BellRing, Copy, Moon } from '../components/icons';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, Card, Chip, ListGroup, ListRow, SectionHeader, Toggle } from '../components/ui';
import { describeTestPush, enableNtfy, enableWebPush, openNtfySubscribe, sendTestPush, webPushServer, webPushState, type PushState } from '../lib/push';
import { pushPrefsKey, quietHours, usePushPrefs } from '../lib/pushPrefs';
import { loadShadeApprovals, saveShadeApprovals, SHADE_PREVIEW_NOTE, shadeSavedNote, shadeToggleView, type ShadeApprovals } from '../lib/shadeApprovals';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';

/** Turn on notifications: Web Push in the web app, the free ntfy app on Android. */
export default function NotificationsScreen() {
  const allServers = useApp((st) => st.servers);
  // A device has one subscription and one set of quiet hours per Hermes server.
  const servers = allServers.filter((server) => !server.parent);
  return (
    <Screen title="Notifications">
      {Platform.OS === 'web' ? <WebPushSettings servers={servers} /> : servers.map((srv) => pushNative ? <EncryptedPushSettings key={srv.id} server={srv} /> : <NtfySettings key={srv.id} server={srv} />)}
      {Platform.OS === 'android' ? servers.map((srv) => (
        <ShadeApprovalsSetting key={`shade-${srv.id}`} server={srv} named={servers.length > 1} />
      )) : null}
      {(Platform.OS === 'web' ? [webPushServer(servers)].filter((x): x is Server => !!x) : servers).map((srv) => (
        <QuietSettings key={srv.id} server={srv} named={servers.length > 1} />
      ))}
    </Screen>
  );
}

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

function clock(hhmm: string) {
  const d = new Date();
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Quiet hours and muted chats for this device. Kept on the server, so they hold while the app is closed. */
function QuietSettings({ server, named }: { server: Server; named: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const supported = useApp((st) => !!st.runtime[server.id]?.info?.features?.mute);
  const chats = useApp((st) => st.runtime[server.id]?.chats);
  const prefs = usePushPrefs((st) => st.byServer[pushPrefsKey(server)]);
  const [editing, setEditing] = useState<'start' | 'end' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (supported) usePushPrefs.getState().load(server);
  }, [supported, server]);

  if (!supported) return null;
  const quiet = prefs?.quiet;
  const save = (change: Parameters<ReturnType<typeof usePushPrefs.getState>['save']>[1]) => {
    setError('');
    usePushPrefs.getState().save(server, change).catch((e) => setError((e as Error).message));
  };
  const muted = Object.entries(prefs?.muted ?? {}).filter(([, until]) => until === 0 || until > Date.now() / 1000);
  const chatName = (id: string) => id === '*' ? 'Everything' : id === homeChat(useApp.getState().runtime[server.id]) ? server.bot.title : chats?.[id]?.kind === 'home' ? 'Reports' : `#${chats?.[id]?.title ?? id}`;

  return (
    <>
      <SectionHeader title={named ? `${server.bot.title}: quiet hours` : 'Quiet hours'} />
      <ListGroup>
        <ListRow icon={<Moon size={18} color={t.colors.textSecondary} />} title="Quiet hours" value={quiet ? 'On' : 'Off'}
          right={<Toggle label="Quiet hours" value={!!quiet} onValueChange={(on) => save((p) => ({ ...p, quiet: on ? quietHours('22:00', '07:00', true) : undefined }))} />} />
        {quiet ? (
          <>
            <ListRow title="Starts" value={clock(quiet.start)} onPress={() => setEditing('start')} />
            <ListRow title="Ends" value={clock(quiet.end)} onPress={() => setEditing('end')} />
            <ListRow title="Allow approvals & questions"
              right={<Toggle label="Allow approvals and questions during quiet hours" value={quiet.allow_urgent}
                onValueChange={(v) => save((p) => ({ ...p, quiet: p.quiet && { ...p.quiet, allow_urgent: v } }))} />} />
          </>
        ) : null}
      </ListGroup>
      {muted.length ? (
        <>
          <SectionHeader title="Muted" />
          <ListGroup>
            {muted.map(([id, until]) => (
              <ListRow key={id} icon={<BellOff size={18} color={t.colors.textSecondary} />} title={chatName(id)}
                subtitle={until ? `Until ${new Date(until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Until unmuted'}
                right={<Button title="Unmute" size="sm" variant="tonal" onPress={() => save((p) => {
                  const next = { ...p.muted };
                  delete next[id];
                  return { ...p, muted: next };
                })} />} />
            ))}
          </ListGroup>
        </>
      ) : null}
      {error ? <Text style={[s.note, { color: t.colors.danger, marginTop: 8 }]} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={editing === 'start' ? 'Quiet from' : 'Quiet until'}>
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={s.times}>
          {TIMES.map((time) => (
            <Chip key={time} label={clock(time)} selected={quiet?.[editing ?? 'start'] === time} onPress={() => {
              const which = editing;
              setEditing(null);
              if (which) save((p) => ({ ...p, quiet: p.quiet && { ...p.quiet, [which]: time } }));
            }} />
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}


/** Per-device opt-in for answering approvals from the shade. Everyone can read it; only a verified
 * owner can change it, and the server says so through can_enable. */
function ShadeApprovalsSetting({ server, named }: { server: Server; named: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const me = useApp((st) => st.runtime[server.id]?.me);
  const [state, setState] = useState<ShadeApprovals | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    loadShadeApprovals(server).then((next) => { if (live) setState(next); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [server.id, server.token]);
  const view = shadeToggleView(state, me);
  const change = async (enabled: boolean) => {
    if (!state?.can_enable || busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const next = await saveShadeApprovals(server, enabled);
      setState(next);
      setSaved(shadeSavedNote(state, next));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <SectionHeader title={named ? `${server.bot.title}: approval actions` : 'Approval actions'} />
      <ListGroup>
        <ListRow title="Approve from notifications" subtitle={view.note}
          right={<Toggle label="Approve from notifications" value={view.value}
            disabled={view.disabled || busy} onValueChange={change} />} />
      </ListGroup>
      {error ? <Text style={[s.note, { color: t.colors.danger, marginTop: 8 }]} accessibilityLiveRegion="polite">{error}</Text> : null}
      {saved ? <Text style={[s.note, { marginTop: 8 }]} accessibilityLiveRegion="polite">{saved}</Text> : null}
      <Text style={[s.note, { marginTop: 8 }]}>{SHADE_PREVIEW_NOTE}</Text>
    </>
  );
}

function WebPushSettings({ servers }: { servers: Server[] }) {
  const t = useTheme();
  const s = useStyles();
  const server = webPushServer(servers);
  const [state, setState] = useState<PushState>(webPushState());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  let body: React.ReactNode;
  if (!server) body = <Text style={s.note}>Open Winglet at your server's address to enable notifications.</Text>;
  else if (state === 'insecure') body = <Text style={s.note}>Open your server's HTTPS address to enable notifications.</Text>;
  else if (state === 'needs-install') body = <Text style={s.note}>On iPhone, use Share → Add to Home Screen, then open Winglet there.</Text>;
  else if (state === 'unsupported') body = <Text style={s.note}>This browser doesn't support push notifications.</Text>;
  else if (state === 'denied') body = <Text style={s.note}>Allow this site's notifications in browser or system settings.</Text>;
  else {
    body = (
      <>
        <Text style={s.note}>
          {state === 'granted' ? `Notifications are on for ${server.bot.title}.`
            : 'Notify me about approvals, questions and reports.'}
        </Text>
        <View style={s.buttons}>
          <Button title={state === 'granted' ? 'Re-register this device' : 'Turn on notifications'} icon={<BellRing size={17} color={t.colors.onAccent} />}
            loading={busy} onPress={async () => {
              setBusy(true);
              try { setState(await enableWebPush(server)); setMsg(''); } catch (e) { setMsg((e as Error).message); }
              setBusy(false);
            }} />
          {state === 'granted' ? (
            <Button title="Send a test" variant="secondary" onPress={async () => {
              try { setMsg(describeTestPush(await sendTestPush(server))); } catch (e) { setMsg((e as Error).message); }
            }} />
          ) : null}
        </View>
      </>
    );
  }
  return (
    <>
      <SectionHeader title="This device" />
      <Card style={{ gap: 14 }}>
        {body}
        {msg ? <Text style={[s.note, { color: t.colors.text }]} accessibilityLiveRegion="polite">{msg}</Text> : null}
      </Card>
    </>
  );
}

function NtfySettings({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const [topic, setTopic] = useState<{ server: string; topic: string } | null>(null);
  const [error, setError] = useState('');
  return (
    <>
      <SectionHeader title={server.bot.title} />
      <Card style={{ gap: 14 }}>
        <View style={s.botRow}>
          <AgentFace server={server} size={36} still />
          <Text style={[s.note, { flex: 1 }]}>
            ntfy can see bot names and timing, not message details. Install the current Android build for encrypted notifications.
          </Text>
        </View>
        {topic ? (
          <>
            <Text style={s.note}>Subscribe to this topic in ntfy (server {topic.server}):</Text>
            <Text selectable style={s.topic}>{topic.topic}</Text>
            <View style={s.buttons}>
              <Button title="Open in ntfy" onPress={() => openNtfySubscribe(topic.server, topic.topic)} />
              <Button title="Copy topic" variant="secondary" icon={<Copy size={16} color={t.colors.text} />} onPress={() => Clipboard.setStringAsync(topic.topic)} />
            </View>
          </>
        ) : (
          <Button title="Set up notifications" icon={<BellRing size={17} color={t.colors.onAccent} />} onPress={async () => {
            try { setTopic(await enableNtfy(server)); } catch (e) { setError((e as Error).message); }
          }} />
        )}
        {error ? <Text style={[s.note, { color: t.colors.danger }]}>{error}</Text> : null}
      </Card>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  botRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', paddingBottom: 8 },
  topic: { ...t.type.callout, fontFamily: t.fonts.mono, color: t.colors.text, backgroundColor: t.colors.surfaceSunken, padding: 12, borderRadius: t.radius.md },
}));
