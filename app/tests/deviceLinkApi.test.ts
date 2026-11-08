import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
const fp = 'f'.repeat(22);
function harness() {
  const calls: any[] = [], signatures: any[] = [], storage: any[] = [], exports: any = {};
  const modules: any = {
    'react-native': { Platform: { OS: 'web' } }, 'expo/fetch': { fetch: async (url: string, init: any) => {
      calls.push({ url, ...init }); const data = url.endsWith('/api/info') ? { app: 'winglet', server_id: 's' } : url.endsWith('/api/server-key') ? { fingerprint: fp } : url.endsWith('/api/pair') ? { server_id: 's', token: 'fake', device: { id: 'd' }, bot: { name: 'main' } } : {};
      return { ok: true, json: async () => data };
    } },
    './crypto': { newSigningKey: () => ({ secret: 'test-only-secret', public: 'test-public' }), checkServerKey: () => {}, seal: (_: any, __: any, ___: any, data: any) => JSON.stringify(data), signedHeaders: (...args: any[]) => { signatures.push(args); return { 'X-Winglet-Signature': 'fake-signature' }; } },
    './storage': { getItem: async () => 'test-only-secret', setItem: async (...args: any[]) => storage.push(args) }, './verify': { useVerify: { getState: () => ({ ask: () => {} }) } },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (n: string) => modules[n], URL, URLSearchParams, AbortController, setTimeout, clearTimeout, FormData, Date, JSON, Error });
  return { api: exports, calls, signatures, storage };
}
test('code-only pairing never pins an identity learned only from the network', async () => {
  const h = harness(); const server = await h.api.pair('https://box.example', 'ABCD2345', 'Browser');
  assert.equal(server.fingerprint, undefined); assert.equal(server.wsAuth, true);
  const pinned = await h.api.pair('https://box.example', 'ABCD2345', 'Browser', fp); assert.equal(pinned.fingerprint, fp);
});
test('ordinary pairing links reject credentials, queries and ignored fragment suffixes', () => {
  const { api } = harness(); assert.equal(api.parsePairLink(`https://box.example/#pair=ABCD2345&fp=${fp}`).fp, fp);
  for (const text of [`https://user@box.example/#pair=ABCD2345&fp=${fp}`, `https://box.example/?leak=1#pair=ABCD2345&fp=${fp}`, `https://box.example/#pair=ABCD2345&fp=${fp}&evil=1`]) assert.equal(api.parsePairLink(text), null);
});
test('signed GET preview uses the unchanged signing protocol with an empty body', async () => {
  const h = harness(); await h.api.signedApi({ id: 's', url: 'https://box.example', token: 'fake', deviceId: 'd' }, 'GET', '/api/device-links/request');
  assert.equal(h.signatures[0][2], 'GET'); assert.equal(h.signatures[0][4], ''); assert.equal(h.calls[0].body, undefined);
});
