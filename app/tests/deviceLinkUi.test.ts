import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = (p: string) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
test('pair screen has first-class paste, shared verification flow and honest limited/role success', () => {
  const s = source('app/pair.tsx'); assert.match(s, /Paste pairing link/); assert.match(s, /connectPairing/); assert.match(s, /BrowserSignIn/); assert.match(s, /Complete verification/); assert.match(s, /result\.role/);
});
test('scan branches browser requests before ordinary pairing without auto-approving', () => {
  const s = source('app/scan.tsx'); assert.match(s, /parseDeviceLink/); assert.match(s, /\/link-device/); assert.match(s, /connectPairing/); assert.doesNotMatch(s, /decideDeviceLink/);
});
test('browser panel wires visibility and navigation cleanup into polling lifecycle', () => {
  const s = source('components/BrowserSignIn.tsx'); assert.match(s, /visibilitychange/); assert.match(s, /useFocusEffect/); assert.match(s, /session.pause\(\)/); assert.match(s, /Retry saving/); assert.match(s, /New QR/);
});
test('approval screen defaults member and needs explicit check-code confirmation', () => {
  const s = source('app/link-device.tsx'); assert.match(s, /useState<Role>\('member'\)/); assert.match(s, /useState\(false\)/); assert.match(s, /Only approve a browser you are signing into/); assert.match(s, /requester-supplied/); assert.match(s, /confirmed/);
});
test('trusted Add-device QR/copy/share remains alongside scan-to-authorize navigation', () => {
  const s = source('app/devices.tsx'); assert.match(s, /Scan browser QR/); assert.match(s, /Add a device/); assert.match(s, /Copy link/); assert.match(s, /SystemShare.share/); assert.match(s, /<QrCode value=\{link\}/);
});
test('web hash login opens a local approval route rather than navigating to the QR URL', () => {
  const s = source('app/(tabs)/index.tsx'); assert.match(s, /parseDeviceLink/); assert.match(s, /pathname: '\/link-device'/);
});

test('the browser QR is offered even when a server is already saved', () => {
  // It was hidden whenever the app already had a server, so the one-tap path disappeared for every
  // returning user and left only "paste a link" or "address and code" — the double sign-in.
  const s = source('app/pair.tsx');
  assert.ok(!/initialUnpaired/.test(s), 'the QR must not depend on having no saved server');
  assert.match(s, /Platform\.OS === 'web' && !params\.code && !manualChosen/);
});
