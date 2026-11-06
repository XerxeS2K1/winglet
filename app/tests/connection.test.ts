import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/connection.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, URL, require: () => ({}) });
const { connectionView, diagnosticReport, addressKind, span, tunnelSummary, deliverySummary, checkAddress, modeSummary } = exports;

const rt = (over: any = {}) => ({ status: 'online', conn: { recovering: false, history: [] }, outbox: [], ...over });

test('each connection problem gets its own state and the right action', () => {
  assert.equal(connectionView(true, rt(), 'Bot').kind, 'online');
  assert.equal(connectionView(false, rt({ status: 'offline' }), 'Bot').kind, 'no-internet');
  assert.equal(connectionView(false, rt({ status: 'offline' }), 'Bot').action, 'retry');
  // A connection that is open beats a stale "no internet" reading from the phone.
  assert.equal(connectionView(false, rt({ status: 'online' }), 'Bot').kind, 'online');
  const unreachable = connectionView(true, rt({ status: 'offline', conn: { recovering: false, history: [], nextRetryAt: 6000 } }), 'Bot', 1000);
  assert.equal(unreachable.kind, 'unreachable');
  assert.equal(unreachable.action, 'retry');
  assert.match(unreachable.detail, /in 5s/);
  assert.equal(connectionView(true, rt({ status: 'offline', conn: { recovering: true, history: [] } }), 'Bot').kind, 'recovering');
  const signedOut = connectionView(true, rt({ status: 'unauthorized' }), 'Bot');
  assert.equal(signedOut.kind, 'signed-out');
  assert.equal(signedOut.action, 'pair');
  assert.equal(connectionView(true, rt({ compat: 'update-server' }), 'Bot').kind, 'update-server');
  assert.equal(connectionView(true, rt({ compat: 'update-app' }), 'Bot').kind, 'update-app');
});

test('address kinds never reveal the address', () => {
  assert.equal(addressKind('https://quiet-river-lamp.trycloudflare.com'), 'automatic HTTPS (quick tunnel)');
  assert.equal(addressKind('http://192.168.1.20:8787'), 'local network');
  assert.equal(addressKind('https://box.tail1234.ts.net'), 'Tailscale');
  assert.equal(addressKind('https://agent.example.com'), 'custom domain');
});

test('the diagnostic report has states and versions but no secrets, addresses or messages', () => {
  const report = diagnosticReport({
    bot: 'Bot', url: 'https://secret-host-name.trycloudflare.com', recovery: true, network: true, appVersion: '0.1.3',
    appProtocol: 1, platform: 'android',
    rt: rt({ status: 'offline', info: { version: '0.1.3', hermes_version: '2026.9', protocol: 1 },
      conn: { recovering: false, lastError: 'connection lost', history: [{ t: 0, status: 'offline', note: 'connection lost' }] },
      outbox: [{ client_id: 'c', chat_id: 'general', text: 'my private message', created_at: 1 }] }),
  }, 10_000);
  assert.match(report, /app: 0\.1\.3/);
  assert.match(report, /hermes 2026\.9/);
  assert.match(report, /queued messages: 1/);
  assert.match(report, /10s ago\s+offline/);
  for (const secret of ['secret-host-name', 'my private message', 'token', 'general']) assert.equal(report.includes(secret), false, secret);
});

test('times read as plain spans', () => {
  assert.equal(span(20_000), 'under a minute');
  assert.equal(span(5 * 60_000), '5 min');
  assert.equal(span(3 * 3600_000), '3 h');
  assert.equal(span(72 * 3600_000), '3 days');
});

test('the tunnel says whether it is up, starting, or when it tries again', () => {
  const now = 1_000_000_000;
  assert.deepEqual({ ...tunnelSummary({ state: 'ready', since: now / 1000 - 7200, error: null, retry_at: null }, now) }, { tone: 'ok', text: 'Up for 2 h' });
  assert.equal(tunnelSummary({ state: 'starting', since: 0, error: null, retry_at: null }, now).tone, 'info');
  assert.equal(tunnelSummary({ state: 'retrying', since: 0, error: 'x', retry_at: now / 1000 + 12 }, now).text, 'Down. Trying again in 12s');
  assert.equal(tunnelSummary({ state: 'retrying', since: 0, error: 'x', retry_at: now / 1000 - 1 }, now).text, 'Down. Trying again now');
  assert.match(modeSummary('quick').detail, /Cloudflare can see/);
});

test('deliveries say whether the last one went through', () => {
  const now = 1_000_000_000;
  assert.equal(deliverySummary(null, now), null);
  assert.equal(deliverySummary({ at: now / 1000 - 10, ok: true }, now), 'Last one went through just now');
  assert.equal(deliverySummary({ at: now / 1000 - 600, ok: false }, now), "Last one didn't go through (10 min ago)");
});

test('a new address is cleaned up, or refused with a reason', () => {
  assert.equal(checkAddress(' hermes.tail1234.ts.net/ ', 'https://a.trycloudflare.com').url, 'https://hermes.tail1234.ts.net');
  assert.equal(checkAddress('192.168.1.5:8787', 'https://a.trycloudflare.com').url, 'http://192.168.1.5:8787');
  assert.equal(checkAddress('box.local', 'https://a.trycloudflare.com').url, 'http://box.local');
  assert.equal(checkAddress('https://example.com/winglet/', 'https://a.trycloudflare.com').url, 'https://example.com/winglet');
  assert.ok(checkAddress('', 'x').error);
  assert.ok(checkAddress('https://user:pw@example.com', 'x').error);
  assert.ok(checkAddress('https://example.com/?a=1', 'x').error);
  assert.ok(checkAddress('ftp://example.com', 'x').error);
  assert.match(checkAddress('https://a.trycloudflare.com/', 'https://a.trycloudflare.com').error, /already/);
});

test('a tunnel status from before the phone lost the server is only the last known one', () => {
  const now = 1_000_000_000;
  const up = { state: 'ready', since: now / 1000 - 7200, error: null, retry_at: null };
  const stale = tunnelSummary(up, now, now - 5 * 60_000);
  assert.equal(stale.tone, 'unknown');
  assert.equal(stale.text, 'Unknown right now. Last known: up, 5 min ago');
  // It no longer counts up, however long the phone stays offline.
  assert.doesNotMatch(tunnelSummary(up, now + 3600_000, now - 5 * 60_000).text, /Up for/);
  assert.match(tunnelSummary({ state: 'retrying', since: 0, error: 'x', retry_at: now / 1000 + 5 }, now, now - 1000).text, /Last known: down, just now/);
});
