import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { ed25519 } from '@noble/curves/ed25519.js';
const id = 'A'.repeat(32), fp = 'f'.repeat(22), base = 'https://box.example';
const encode = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const secret = new Uint8Array(32).fill(7), pub = encode(ed25519.getPublicKey(secret));
const parent: any = { id: 'server', url: base, fingerprint: fp, token: 'fake', deviceId: 'phone', bot: { name: 'main' } };
function harness() {
  let now = 1000_000, answer: any = { status: 'pending', expires_at: 1180 }, failSave = false, failClaim = 0;
  const calls: any[] = [], saves: any[] = [], timers = new Map<number, () => void>(), states: any[] = [], storage: any[] = [];
  let seq = 0;
  const exports: any = {};
  const modules: any = {
    './api': {
      normalizeUrl: (x: string) => x.replace(/\/+$/, ''), fetchInfo: async () => ({ server_id: 'server', app: 'winglet', features: { device_linking: true } }),
      serverKey: async (_: string, pin: string) => { if (pin && pin !== fp) throw Error('mismatch'); return { fingerprint: fp }; },
      hasSigningKey: async () => true,
      request: async (url: string, init: any) => { calls.push({ url, ...init }); if (url.endsWith('/claim')) { if (failClaim) { const e: any = Error('temporary'); e.status = failClaim; throw e; } return answer; }
        return { id, poll_token: 'p'.repeat(32), verification_code: '012345', expires_at: 1180, fingerprint: fp }; },
      signedApi: async (s: any, method: string, path: string, body: any) => { calls.push({ s, method, path, body }); return { id, device_name: 'Browser', platform: 'web', sign_key: pub, verification_code: '012345', expires_at: 1180, status: 'pending' }; },
    },
    './crypto': { newSigningKey: () => ({ secret: encode(secret), public: pub }), b64d: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')), b64e: encode, seal: (_: any, purpose: string, device: string, data: any) => JSON.stringify({ purpose, device, data }) },
    './storage': { setItem: async (...args: any[]) => storage.push(args) }, '@noble/curves/ed25519.js': { ed25519 },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/deviceLinks.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, URL, URLSearchParams, TextEncoder, Uint8Array, AbortController, Date, Error, Number,
      setTimeout: (fn: () => void) => { timers.set(++seq, fn); return seq; }, clearTimeout: (n: number) => timers.delete(n) });
  const make = () => new exports.BrowserDeviceLink(base, 'Browser', async (s: any, key: string) => { if (failSave) throw Error('disk full'); saves.push(s); await exports.saveBrowserPair(s, key, async () => {}); }, (s: any) => states.push(s), () => now);
  return { lib: exports, make, calls, saves, states, timers, storage, answer: (x: any) => { answer = x; }, failSave: (x: boolean) => { failSave = x; }, failClaim: (x: number) => { failClaim = x; }, now: (x: number) => { now = x; }, modules };
}
test('switching to manual pairing cancels pending QR polling but cannot interrupt a claim', async () => {
  const h = harness(), s = h.make(); await s.start(); let resolve: any;
  const normalRequest = h.modules['./api'].request;
  h.modules['./api'].request = () => new Promise((r) => { resolve = r; });
  const request = s.poll(); assert.equal(s.beginManual(), false);
  resolve({ status: 'pending', expires_at: 1180 }); await request;
  h.modules['./api'].request = normalRequest;
  assert.equal(s.beginManual(), true); const count = h.calls.length; await s.poll(); assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0);
});
test('a claim completed while hidden waits for saving and exposes Retry saving on resume', async () => {
  const h = harness(), s = h.make(); await s.start();
  let resolve: any; h.modules['./api'].request = () => new Promise((r) => { resolve = r; });
  const pending = s.poll(); s.pause();
  resolve({ status: 'paired', token: 'fake-browser-token', device: { id: 'browser' }, me: { role: 'owner', verified: true }, server_id: 'server', bot: { name: 'main' } });
  await pending; assert.equal(h.saves.length, 0); s.resume();
  assert.equal(h.states.at(-1).phase, 'save-error'); await s.retrySave(); assert.equal(s.state.phase, 'paired');
});
test('unknown server, wrong pin, member and unverified owner refuse without any signed request', async () => {
  for (const [servers, runtime] of [
    [[], {}], [[{ ...parent, url: 'https://evil.example' }], { server: { me: { role: 'owner', verified: true } } }],
    [[{ ...parent, fingerprint: 'wrong' }], { server: { me: { role: 'owner', verified: true } } }],
    [[parent], { server: { me: { role: 'member', verified: true } } }], [[parent], { server: { me: { role: 'owner', verified: false } } }],
  ]) { const h = harness(); await assert.rejects(h.lib.previewDeviceLink(`${base}/#link=${id}&fp=${fp}`, servers, runtime, 1000000), /verified owner/); assert.equal(h.calls.length, 0); }
});
test('a cold load with no socket view yet still asks the server to prove authority', async () => {
  // Opening the approval link fresh (runtime empty) must not refuse: the signed request decides.
  const h = harness();
  const preview = await h.lib.previewDeviceLink(`${base}/#link=${id}&fp=${fp}`, [parent], {}, 1000000);
  assert.equal(preview.id, id);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
});
test('expiry and denial stop polling; hidden/unmounted session sends no further claim', async () => {
  const h = harness(), s = h.make(); await s.start(); const before = h.calls.length; s.pause(); await s.poll(); assert.equal(h.calls.length, before); assert.equal(h.timers.size, 0);
  h.now(1180001); s.resume(); await s.poll(); assert.equal(s.state.phase, 'expired'); assert.equal(h.calls.length, before); assert.equal(h.timers.size, 0);
  const d = harness(), deny = d.make(); await deny.start(); d.answer({ status: 'denied', expires_at: 1180 }); await deny.poll(); assert.equal(deny.state.phase, 'denied'); assert.equal(d.timers.size, 0);
});
test('transient claim errors retry only until the deadline; 404 is final expiry', async () => {
  const h = harness(), s = h.make(); await s.start(); h.failClaim(503); await s.poll(); assert.equal(s.state.phase, 'waiting'); assert.equal(h.timers.size, 1);
  h.failClaim(404); await s.poll(); assert.equal(s.state.phase, 'expired'); assert.equal(h.timers.size, 0);
});
test('browser storage retry reuses the one-use claim and identity without another network request', async () => {
  const h = harness(), s = h.make(); await s.start(); h.failSave(true);
  h.answer({ status: 'paired', token: 'fake-browser-token', device: { id: 'browser' }, me: { role: 'owner', verified: true }, server_id: 'server', bot: { name: 'main' } });
  await s.poll(); assert.equal(s.state.phase, 'save-error'); const calls = h.calls.length;
  await s.start(); assert.equal(h.calls.length, calls); h.failSave(false); await s.retrySave();
  assert.equal(s.state.phase, 'paired'); assert.equal(h.calls.length, calls); assert.equal(h.saves.length, 1);
});
test('older servers offer fallback without creating a device-link request', async () => {
  const h = harness(); h.modules['./api'].fetchInfo = async () => ({ server_id: 'server', features: {} }); const s = h.make(); await s.start();
  assert.equal(s.state.phase, 'unsupported'); assert.equal(h.calls.length, 0);
});
test('denial is signed with empty payload; expired or demoted approver cannot approve', async () => {
  const h = harness(), runtime = { server: { me: { role: 'owner', verified: true } } };
  const p = await h.lib.previewDeviceLink(`${base}/#link=${id}&fp=${fp}`, [parent], runtime, 1000000);
  await h.lib.decideDeviceLink(p, 'deny', 'member', false, [parent], runtime, 1000000);
  assert.equal(h.calls[1].path, `/api/device-links/${id}/deny`); assert.equal(JSON.stringify(h.calls[1].body), '{}');
  await assert.rejects(h.lib.decideDeviceLink(p, 'approve', 'owner', true, [parent], runtime, 1180001), /expired/);
  runtime.server.me.role = 'member'; await assert.rejects(h.lib.decideDeviceLink(p, 'approve', 'owner', true, [parent], runtime, 1000000), /verified owner/);
  assert.equal(h.calls.length, 2);
});
test('phone preview is signed on the known parent and explicit approval binds role/key/code', async () => {
  const h = harness(); const runtime = { server: { me: { role: 'owner', verified: true } } };
  const preview = await h.lib.previewDeviceLink(`${base}/#link=${id}&fp=${fp}`, [parent, { ...parent, id: 'server~bot', parent: 'server', profile: 'bot' }], runtime, 1000000);
  assert.equal(h.calls[0].method, 'GET'); assert.equal(h.calls[0].s.profile, undefined); assert.equal(h.calls[0].path, `/api/device-links/${id}`);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.lib.decideDeviceLink(preview, 'approve', 'member', false, [parent], runtime, 1000000), /match/);
  assert.equal(h.calls.length, 1);
  await h.lib.decideDeviceLink(preview, 'approve', 'member', true, [parent], runtime, 1000000);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].body)), { role: 'member', sign_key: pub, verification_code: '012345' });
});
test('browser creates a secret-free QR and claims with its own Ed25519 proof before standard storage', async () => {
  const h = harness(), session = h.make(); await session.start();
  assert.equal(session.state.phase, 'waiting'); assert.equal(session.state.code, '012345');
  assert.equal(session.state.qr, `${base}/#link=${id}&fp=${fp}`);
  assert.equal(JSON.stringify(session.state).includes('p'.repeat(32)), false); assert.equal(JSON.stringify(session.state).includes(encode(secret)), false);
  const created = JSON.parse(h.calls[0].body); const envelope = JSON.parse(created.sealed);
  assert.equal(envelope.purpose, 'device-link-create'); assert.equal(envelope.data.sign_key, pub);
  h.answer({ status: 'paired', token: 'fake-browser-token', device: { id: 'browser-device' }, me: { role: 'member', verified: true }, server_id: 'server', bot: { name: 'main' } });
  await session.poll();
  const claim = JSON.parse(JSON.parse(h.calls.at(-1).body).sealed);
  assert.equal(claim.purpose, 'device-link-claim'); assert.equal(claim.device, id);
  assert.ok(ed25519.verify(Buffer.from(claim.data.signature, 'base64url'), new TextEncoder().encode(`winglet-device-link-claim-v1\n${id}\n${'p'.repeat(32)}`), ed25519.getPublicKey(secret)));
  assert.equal(session.state.phase, 'paired'); assert.equal(session.state.role, 'member');
  assert.equal(h.saves[0].deviceId, 'browser-device'); assert.notEqual(h.saves[0].deviceId, parent.deviceId);
  assert.equal(h.storage[0][0], 'winglet.sign.server'); assert.equal(h.timers.size, 0);
});
test('browser-login QR parses only an exact public id/fingerprint link', () => {
  const { lib } = harness();
  assert.equal(lib.parseDeviceLink(`${base}/#link=${id}&fp=${fp}`).url, base);
  for (const text of [`javascript:alert(1)#link=${id}&fp=${fp}`, `https://user@box.example/#link=${id}&fp=${fp}`, `${base}/?x=1#link=${id}&fp=${fp}`, `${base}/#link=${id}&fp=${fp}&poll_token=secret`, `${base}/#link=short&fp=${fp}`, `${base}/#pair=ABCD2345&fp=${fp}`]) assert.equal(lib.parseDeviceLink(text), null);
});
