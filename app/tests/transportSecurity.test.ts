import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { apiHarness } from './helpers/apiHarness.ts';

// Hosts where plain http is fine: the path is local or already encrypted (Tailscale).
const LOCAL = ['localhost:8787', '127.0.0.1:8787', '127.5.5.5', '10.0.0.5:8787', '10.255.255.255', '172.16.0.1', '172.31.255.254:8787',
  '192.168.1.20:8787', '192.168.0.1', '100.64.0.1:8787', '100.127.255.255', '169.254.10.20', 'box.local', 'box.local:8787', 'My-Box.local.',
  'laptop.tail1234.ts.net', 'laptop.tail1234.ts.net:8787', '[::1]:8787', '[fd12:3456::1]:8787', '[fe80::1]:8787'];
// Hosts that are not: a scheme-less address to any of these has to become https.
const PUBLIC = ['box.example', 'box.example:8787/', '203.0.113.5:8787', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1',
  '192.169.1.1', '11.0.0.1', '9.255.255.255', '192.168.1.1.evil.example', 'box.local.evil.example', 'notlocal', 'ts.net.evil.example',
  'box.tsnet', '192.168.1.5@evil.example', '[2001:db8::1]:8787', '[fec0::1]', 'localhost.evil.example'];

test('a scheme-less address stays http only for local and Tailscale hosts', () => {
  const { api } = apiHarness();
  for (const host of LOCAL) assert.equal(api.normalizeUrl(host), `http://${host.replace(/\/+$/, '')}`, host);
  for (const host of PUBLIC) assert.equal(api.normalizeUrl(host), `https://${host.replace(/\/+$/, '')}`, host);
});

test('an address typed with its scheme keeps it, so saved servers are still recognised', () => {
  const { api } = apiHarness();
  assert.equal(api.normalizeUrl('https://box.example/'), 'https://box.example');
  assert.equal(api.normalizeUrl('HTTPS://Box.Example//'), 'HTTPS://Box.Example');
  assert.equal(api.normalizeUrl('http://192.168.1.20:8787/'), 'http://192.168.1.20:8787');
  assert.equal(api.normalizeUrl('http://203.0.113.5:8787'), 'http://203.0.113.5:8787'); // refused later, by assertSecureAddress
  assert.equal(api.normalizeUrl('  '), '');
});

test('assertSecureAddress refuses explicit http to any other host with a plain message, and allows the rest', () => {
  const { api } = apiHarness();
  for (const host of PUBLIC.filter((h) => !h.includes('@'))) {
    assert.throws(() => api.assertSecureAddress(`http://${host}`), (e: any) => e instanceof api.ApiError && /https/.test(e.message) && !/token|key|fingerprint/i.test(e.message), host);
  }
  assert.throws(() => api.assertSecureAddress('http://192.168.1.5@evil.example'), /https/);
  assert.throws(() => api.assertSecureAddress('HTTP://box.example'), /https/);
  for (const host of LOCAL) assert.doesNotThrow(() => api.assertSecureAddress(`http://${host.replace(/\/+$/, '')}`), host);
  for (const host of [...LOCAL, ...PUBLIC.filter((h) => !h.includes('@'))]) assert.doesNotThrow(() => api.assertSecureAddress(`https://${host}`), host);
});

test('pairing with an explicit http address to another host is refused before anything is sent', async () => {
  const h = apiHarness();
  for (const url of ['http://203.0.113.5:8787', 'http://box.example', 'HTTP://box.example/']) {
    await assert.rejects(h.api.pair(url, 'ABCD2345', 'Phone'), (e: any) => e instanceof h.api.ApiError && /https/.test(e.message), url);
  }
  assert.deepEqual(h.calls, [], 'no request, so no pairing code or key left the phone');
  assert.deepEqual(h.storage, []);
});

test('a scheme-less public address is paired over https, never http', async () => {
  const h = apiHarness();
  const server = await h.api.pair('203.0.113.5:8787', 'ABCD2345', 'Phone');
  assert.equal(server.url, 'https://203.0.113.5:8787');
  assert.ok(h.calls.length >= 3 && h.calls.every((c: any) => c.url.startsWith('https://203.0.113.5:8787/')), JSON.stringify(h.calls.map((c: any) => c.url)));
});

test('an https pairing still completes', async () => {
  const h = apiHarness();
  const server = await h.api.pair('https://box.example', 'ABCD2345', 'Phone', 'f'.repeat(22));
  assert.equal(server.url, 'https://box.example'); assert.equal(server.token, 'fake'); assert.equal(server.wsAuth, true);
});

test('private and Tailscale addresses still pair over http', async () => {
  for (const addr of ['192.168.1.20:8787', 'http://10.0.0.7:8787', 'laptop.tail1234.ts.net:8787', 'http://100.101.102.103:8787', 'box.local']) {
    const h = apiHarness();
    const server = await h.api.pair(addr, 'ABCD2345', 'Phone');
    assert.ok(server.url.startsWith('http://'), `${addr} -> ${server.url}`);
    assert.ok(h.calls.every((c: any) => c.url.startsWith(server.url)), addr);
  }
});

test('a server already paired over a private http address keeps working', async () => {
  const h = apiHarness();
  const old = { id: 's', url: 'http://192.168.1.20:8787', token: 'tok', deviceId: 'd', bot: { name: 'main' } };
  await h.api.api(old, '/api/me');
  assert.equal(h.calls[0].url, 'http://192.168.1.20:8787/api/me');
  assert.equal(h.calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(h.api.wsUrl(old), 'ws://192.168.1.20:8787/api/ws?token=tok');
  assert.equal(h.api.normalizeUrl(old.url), old.url, 'pairing finds it again by address');
});

test('moving a server to an explicit http address on another host is refused before anything is sent', async () => {
  const h = apiHarness();
  const server = { id: 's', url: 'https://box.example', token: 'tok', deviceId: 'd', fingerprint: 'f'.repeat(22), bot: { name: 'main', title: 'Main' } };
  await assert.rejects(h.api.moveServer(server, 'http://203.0.113.5:8787'), (e: any) => e instanceof h.api.ApiError && /https/.test(e.message));
  assert.deepEqual(h.calls, []);
  await assert.rejects(h.api.moveServer(server, 'http://192.168.1.20:8787'), /recognise/); // private http gets as far as asking the server
  assert.ok(h.calls.length > 0 && h.calls.every((c: any) => c.url.startsWith('http://192.168.1.20:8787/')));
});

function pairingFlow() {
  const h = apiHarness(), exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/pairing.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: () => h.api, Error });
  const store: any = { servers: [], addServer: async () => {}, updateServer: async () => {} };
  return { h, connectPairing: exports.connectPairing, store };
}

test('the pairing screen flow refuses an http address to another host before the first request', async () => {
  const f = pairingFlow();
  await assert.rejects(f.connectPairing('http://203.0.113.5:8787', 'ABCD2345', 'Phone', f.store), /https/);
  await assert.rejects(f.connectPairing('http://box.example/#pair=ABCD2345&fp=' + 'f'.repeat(22), '', 'Phone', f.store), /https/);
  assert.deepEqual(f.h.calls, []);
});

test('the pairing screen flow upgrades a typed public address to https and still pairs a private one over http', async () => {
  const pub = pairingFlow();
  const a = await pub.connectPairing('203.0.113.5:8787', 'ABCD2345', 'Phone', pub.store);
  assert.equal(a.server.url, 'https://203.0.113.5:8787');
  assert.ok(pub.h.calls.every((c: any) => c.url.startsWith('https://')));
  const lan = pairingFlow();
  const b = await lan.connectPairing('192.168.1.20:8787', 'ABCD2345', 'Phone', lan.store);
  assert.equal(b.server.url, 'http://192.168.1.20:8787');
});
