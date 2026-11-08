import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
const server = { id: 's', url: 'https://box.example', deviceId: 'phone', token: 'fake-test-token', bot: { name: 'main', title: 'Main' }, addedAt: 1 };
function harness(existing: any[] = []) {
  const calls: any[] = [], saved: any[] = [], updated: any[] = [];
  const api = {
    parsePairLink: (text: string) => text.includes('#pair=') ? { url: server.url, code: 'ABCD2345', ...(text.includes('&fp=') ? { fp: 'f'.repeat(22) } : {}) } : null,
    normalizeUrl: (s: string) => s, fetchInfo: async () => ({ server_id: 's' }),
    pair: async (...args: any[]) => { calls.push(['pair', ...args]); return { ...server, fingerprint: args[3] }; },
    verifyDevice: async (...args: any[]) => { calls.push(['verify', ...args]); return { ...args[0], fingerprint: args[2] }; },
    api: async () => ({ device: { role: 'owner', verified: true } }),
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/pairing.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { assert.equal(name, './api'); return api; }, URL, Error });
  const connect = (input: string) => exports.connectPairing(input, '', 'Phone', { servers: existing, addServer: async (s: any) => saved.push(s), updateServer: async (...s: any[]) => updated.push(s) });
  return { connect, calls, saved, updated };
}
test('an already verified existing pairing keeps its verified access without a new code', async () => {
  const h = harness([{ ...server, fingerprint: 'f'.repeat(22) }]);
  const result = await h.connect('https://box.example/#pair=ABCD2345');
  assert.equal(result.verified, true); assert.equal(h.calls.length, 0);
});
test('existing server link verifies the existing identity and never creates another device', async () => {
  const h = harness([server]); const result = await h.connect('https://box.example/#pair=ABCD2345&fp=' + 'f'.repeat(22));
  assert.equal(h.calls[0][0], 'verify'); assert.equal(h.saved.length, 0); assert.equal(h.updated.length, 1); assert.equal(result.existing, true);
});
test('code-only existing connection is visibly limited and never creates a duplicate', async () => {
  const h = harness([server]); const result = await h.connect('https://box.example/#pair=ABCD2345');
  assert.equal(h.calls.length, 0); assert.equal(result.verified, false); assert.equal(result.existing, true);
});
test('a mismatched pinned fingerprint is refused before pairing or verification', async () => {
  const h = harness([{ ...server, fingerprint: 'other' }]);
  await assert.rejects(h.connect('https://box.example/#pair=ABCD2345&fp=' + 'f'.repeat(22)), /different server key/);
  assert.equal(h.calls.length, 0);
});
test('full pasted link pairs and verifies in one flow and reports actual owner access', async () => {
  const h = harness(); const result = await h.connect('https://box.example/#pair=ABCD2345&fp=' + 'f'.repeat(22));
  assert.equal(h.calls[0][0], 'pair'); assert.equal(h.calls[0][4], 'f'.repeat(22)); assert.equal(h.saved.length, 1);
  assert.equal(result.verified, true); assert.equal(result.role, 'owner');
});
