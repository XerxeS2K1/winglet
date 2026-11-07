import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { defaultDeviceName } from '../lib/api';
import { BrowserDeviceLink, saveBrowserPair, type BrowserLinkState } from '../lib/deviceLinks';
import { useApp } from '../lib/store';
import { makeStyles } from '../lib/themeContext';
import { QrCode } from './QrCode';
import { Button, Card, Footnote } from './ui';

/** Only the browser hosting this app chooses the request origin. Never a scanned URL. */
export function BrowserSignIn({ base, onPhase, sessionRef }: { base: string; onPhase: (phase: BrowserLinkState['phase']) => void; sessionRef: { current: BrowserDeviceLink | null } }) {
  const s = useStyles();
  const [state, setState] = useState<BrowserLinkState>({ phase: 'idle' });
  const changed = useCallback((next: BrowserLinkState) => { setState(next); onPhase(next.phase); }, [onPhase]);
  const session = useMemo(() => new BrowserDeviceLink(base, defaultDeviceName(),
    (server, secret) => saveBrowserPair(server, secret, useApp.getState().addServer), changed), [base, changed]);
  useEffect(() => { sessionRef.current = session; return () => { if (sessionRef.current === session) sessionRef.current = null; }; }, [session, sessionRef]);
  useFocusEffect(useCallback(() => {
    const sync = () => { if (typeof document !== 'undefined' && document.hidden) session.pause(); else session.resume(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);
    sync();
    return () => { session.pause(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync); };
  }, [session]));
  if (state.phase === 'unsupported') return <Footnote>This server does not support QR sign-in yet. Use a pairing link or terminal code below.</Footnote>;
  return <Card style={{ gap: 14, alignItems: 'center' }}>
    {state.phase === 'waiting' && state.qr ? <>
      <QrCode value={state.qr} size={220} label="Browser sign-in request" />
      <Text style={s.code} selectable>{state.code?.slice(0, 3)} {state.code?.slice(3)}</Text>
      <Text style={s.note}>Waiting for your phone</Text>
      <Footnote>On your verified owner phone, open Devices → Link a device → Scan browser QR. Match this check code before approving.</Footnote>
    </> : null}
    {state.phase === 'idle' || state.phase === 'creating' || state.phase === 'saving' ? <Text style={s.note}>{state.phase === 'saving' ? 'Saving this browser…' : 'Preparing sign-in QR…'}</Text> : null}
    {state.phase === 'expired' ? <Text style={s.note}>This QR expired. Create a new one to try again.</Text> : null}
    {state.phase === 'denied' ? <Text style={s.note}>Sign-in was declined on the phone.</Text> : null}
    {state.error ? <Text style={s.error} accessibilityRole="alert">{state.error}</Text> : null}
    {state.phase === 'save-error' ? <Button title="Retry saving" onPress={() => session.retrySave()} /> : null}
    {['expired', 'denied', 'error'].includes(state.phase) ? <Button title="New QR" onPress={() => session.start()} /> : null}
    {state.phase === 'paired' ? <View style={{ gap: 12 }}>
      <Text style={s.note}>This browser is verified as {state.role === 'owner' ? 'an owner' : 'a member'}.</Text>
      <Button title="Continue" onPress={() => router.replace('/')} />
    </View> : null}
  </Card>;
}
const useStyles = makeStyles((t) => ({
  code: { ...t.type.hero, fontFamily: t.fonts.mono, color: t.colors.text, letterSpacing: 3 },
  note: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  error: { ...t.type.callout, color: t.colors.danger, textAlign: 'center' },
}));
