import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { Button, Card, Footnote, Segmented, Toggle } from '../components/ui';
import { decideDeviceLink, previewDeviceLink, type LinkPreview } from '../lib/deviceLinks';
import { useApp } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import type { Role } from '../lib/types';

export default function LinkDeviceScreen() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  return <Approval key={link} link={typeof link === 'string' ? link : ''} />;
}
function Approval({ link }: { link: string }) {
  const s = useStyles();
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [role, setRole] = useState<Role>('member');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [now, setNow] = useState(Date.now());
  const running = useRef(false), active = useRef(true);
  useEffect(() => {
    active.current = true;
    const state = useApp.getState();
    previewDeviceLink(link, state.servers, state.runtime).then((p) => { if (active.current) setPreview(p); })
      .catch((e) => { if (active.current) setError(e.status === 404 ? 'This request expired. Choose New QR in the browser.' : e.message); });
    return () => { active.current = false; };
  }, [link]);
  useEffect(() => {
    if (!preview || done) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview, done]);
  const decide = async (action: 'approve' | 'deny') => {
    if (!preview || running.current) return;
    running.current = true; setBusy(true); setError('');
    try {
      const state = useApp.getState();
      await decideDeviceLink(preview, action, role, confirmed, state.servers, state.runtime);
      if (active.current) setDone(action === 'deny' ? 'Browser sign-in declined.' : `Approved as ${role === 'owner' ? 'an owner' : 'a member'}. The browser can now finish signing in.`);
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { running.current = false; if (active.current) setBusy(false); }
  };
  const expired = !!preview && now >= preview.expires_at * 1000;
  return <Screen title="Browser sign-in">
    {preview && !done ? <Card style={{ gap: 16 }}>
      <Text style={s.address} selectable>{preview.server.url}</Text>
      <Text style={s.code} selectable>{preview.verification_code.slice(0, 3)} {preview.verification_code.slice(3)}</Text>
      <Text style={s.note}>{String(preview.device_name).replace(/[\p{C}]/gu, '').slice(0, 100)} · web</Text>
      <Footnote>These are requester-supplied labels, not a verified browser identity.</Footnote>
      {preview.status === 'pending' && !expired ? <>
        <Text style={s.warning}>Only approve a browser you are signing into. Its check code must match this phone. Someone else can send you their sign-in QR.</Text>
        <Segmented label="Browser access" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'owner', label: 'Owner' }]} />
        <Footnote>{role === 'member' ? 'Members have their own chats, without approvals or settings. Memory and tools are shared: only link people you trust.' : 'Owners can see all chats, approve commands, change settings and manage devices.'}</Footnote>
        <View style={s.confirm}>
          <Text style={s.confirmText}>The code matches the browser I am signing into</Text>
          <Toggle label="The browser check code matches" value={confirmed} onValueChange={setConfirmed} />
        </View>
        <Button title={`Approve as ${role === 'owner' ? 'owner' : 'member'}`} disabled={!confirmed || busy} loading={busy} onPress={() => decide('approve')} />
        <Button title="Decline sign-in" variant="secondary" disabled={busy} onPress={() => decide('deny')} />
      </> : <Text style={s.note}>{expired ? 'This request expired. Choose New QR in the browser.' : 'This request was already handled.'}</Text>}
    </Card> : done ? <Card><Text style={s.note}>{done}</Text></Card> : !error ? <Footnote>Loading browser request…</Footnote> : null}
    {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
    {!preview && error ? <Button title="Connect this phone first" variant="secondary" onPress={() => router.replace('/pair')} /> : null}
    <Button title="Close" variant="ghost" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />
  </Screen>;
}
const useStyles = makeStyles((t) => ({
  address: { ...t.type.callout, color: t.colors.text, textAlign: 'center' },
  code: { ...t.type.hero, fontFamily: t.fonts.mono, color: t.colors.text, letterSpacing: 3, textAlign: 'center' },
  note: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  warning: { ...t.type.callout, color: t.colors.warning },
  error: { ...t.type.callout, color: t.colors.danger, marginVertical: 14 },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  confirmText: { ...t.type.callout, color: t.colors.text, flex: 1 },
}));
