import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, X } from '../components/icons';
import { Button, IconButton, Tap } from '../components/ui';
import { defaultDeviceName, parsePairLink } from '../lib/api';
import { parseDeviceLink } from '../lib/deviceLinks';
import { connectPairing, type PairingResult } from '../lib/pairing';
import { useApp } from '../lib/store';
import { FIXED } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';

const FRAME = 250;
const CORNER = 44;

export default function ScanScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<PairingResult | null>(null);
  const [status, setStatus] = useState<'scanning' | 'pairing' | 'complete' | 'error'>('scanning');
  const [error, setError] = useState('');
  const handled = useRef(false);

  const onScan = async (data: string) => {
    if (handled.current) return;
    if (parseDeviceLink(data)) {
      handled.current = true;
      router.replace({ pathname: '/link-device', params: { link: data } });
      return;
    }
    const link = parsePairLink(data);
    if (!link) {
      setError("That QR code isn't a Winglet pairing code.");
      return;
    }
    handled.current = true;
    try {
      setStatus('pairing');
      setResult(await connectPairing(data, '', defaultDeviceName(), useApp.getState()));
      setStatus('complete');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  if (!permission) return <View style={styles.root} />;

  if (!permission.granted) return <AskCamera onAllow={requestPermission} />;

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={status === 'scanning' ? (r) => onScan(r.data) : undefined}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + 8 }]}>
        <IconButton label="Close" onPress={() => router.back()} style={styles.close}>
          <X size={24} color={FIXED.white} />
        </IconButton>
        <Viewfinder still={status !== 'scanning'} />
        <View style={styles.hintBox}>
          {status === 'pairing' ? <ActivityIndicator color={FIXED.white} /> : null}
          <Text style={styles.hint}>
            {status === 'pairing' ? 'Connecting…' : result ? `${result.verified ? 'Verified' : 'Limited connection'}${result.role ? ` · ${result.role === 'owner' ? 'Owner' : 'Member'}` : ' · Access not checked yet'}`
              : error || 'Scan a pairing code or a browser sign-in QR.'}
          </Text>
          {result ? <>
            <Text style={styles.hint}>{result.verified ? result.role === 'owner' ? 'Owner access includes approvals, settings and device management.' : 'Member access includes your own chats, without approvals or settings.' : 'Paste a full fingerprint-bearing pairing link to complete verification.'}</Text>
            {!result.verified ? <Button title="Complete verification" onPress={() => router.replace('/pair')} /> : null}
            <Button title="Continue" onPress={() => router.replace('/')} />
          </> : null}
          {status === 'error' ? (
            <Button title="Try again" onPress={() => { handled.current = false; setError(''); setStatus('scanning'); }} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Before the camera: why it's needed. */
function AskCamera({ onAllow }: { onAllow: () => unknown }) {
  const t = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.ask, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Camera size={36} color={t.colors.textSecondary} strokeWidth={1.6} />
      <View style={styles.askWords}>
        <Text style={styles.title} accessibilityRole="header">Camera access</Text>
        <Text style={styles.text}>Only used to scan pairing and browser sign-in codes.</Text>
      </View>
      <View style={styles.askActions}>
        <Button title="Allow camera" onPress={() => { onAllow(); }} size="lg" />
        <Button title="Enter the code instead" variant="secondary" size="lg" onPress={() => router.back()} />
      </View>
    </View>
  );
}

/** Four corners marking where to hold the code. */
function Viewfinder(_props: { still: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.frame} pointerEvents="none">
      <View style={[styles.corner, styles.topLeft]} />
      <View style={[styles.corner, styles.topRight]} />
      <View style={[styles.corner, styles.bottomLeft]} />
      <View style={[styles.corner, styles.bottomRight]} />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: FIXED.camera },
  ask: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.space.xl, paddingHorizontal: t.space.xl, backgroundColor: t.colors.bg },
  askWords: { gap: t.space.sm, alignItems: 'center' },
  askActions: { width: '100%', maxWidth: 400, gap: t.space.md },
  title: { ...t.type.title, color: t.colors.text, textAlign: 'center' },
  text: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'space-between', paddingBottom: 60 },
  close: { alignSelf: 'flex-start', marginLeft: 12, backgroundColor: FIXED.cameraScrim, borderRadius: t.radius.pill },
  frame: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: FIXED.cameraFrame },
  topLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 22 },
  topRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 22 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 22 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 22 },
  hintBox: {
    alignItems: 'center', gap: 12, backgroundColor: FIXED.cameraScrim, borderRadius: t.radius.xl, paddingHorizontal: 20, paddingVertical: 16,
    marginHorizontal: 24,
  },
  hint: { ...t.type.callout, color: FIXED.white, textAlign: 'center' },
}));
