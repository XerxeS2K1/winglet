import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { apiHarness } from './helpers/apiHarness.ts';

const SERVER = { id: 's', url: 'https://box.example', token: 'SECRET-DEVICE-TOKEN', deviceId: 'd', bot: { name: 'main' } };
const ORIGIN = new URL(SERVER.url).origin;

// Hrefs that, glued onto the server address as text, move the request to another host.
const HOSTILE = [
  '@evil.example/px.png', '%2f@evil.example/px.png', '%2F@evil.example/px.png', '//evil.example/px.png', '/\\evil.example/px.png',
  '\\\\evil.example/px.png', '/\t/evil.example/px.png', '/\n/evil.example/px.png', '/\r/evil.example/px.png', 'evil.example/px.png',
  '.evil.example/px.png', ':443@evil.example/px.png', '?x=@evil.example/', '#@evil.example/', '',
];

/** A URL that is safe to hand to the image loader: nothing, or an address on the paired server. */
function staysOnServer(url: string) {
  if (url === '') return true;
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}

test('mediaUrl never builds an address on another host, and never gives it the device token', () => {
  const { api } = apiHarness();
  for (const href of HOSTILE) {
    const url = api.mediaUrl(SERVER, href);
    assert.ok(staysOnServer(url), `${JSON.stringify(href)} gave ${JSON.stringify(url)}`);
    if (!url.startsWith(ORIGIN)) assert.ok(!url.includes(SERVER.token), `token leaked in ${JSON.stringify(url)}`);
  }
});

test('mediaUrl refuses these hrefs outright, with no token attached', () => {
  const { api } = apiHarness();
  for (const href of HOSTILE) assert.equal(api.mediaUrl(SERVER, href), '', JSON.stringify(href));
});

test('legitimate server images still load, and old links without a signature still authenticate', () => {
  const { api } = apiHarness();
  assert.equal(api.mediaUrl(SERVER, '/api/media/abc/pic.png?sig=xyz&exp=9'), 'https://box.example/api/media/abc/pic.png?sig=xyz&exp=9');
  assert.equal(api.mediaUrl(SERVER, '/api/media/abc/pic.png'), 'https://box.example/api/media/abc/pic.png?token=SECRET-DEVICE-TOKEN');
  assert.equal(api.mediaUrl(SERVER, '/api/media/abc/pic.png?size=2'), 'https://box.example/api/media/abc/pic.png?size=2&token=SECRET-DEVICE-TOKEN');
  assert.equal(api.mediaUrl(SERVER, '/api/media/a@b%2Fc.png'), 'https://box.example/api/media/a@b%2Fc.png?token=SECRET-DEVICE-TOKEN');
  assert.equal(api.mediaUrl(SERVER, 'https://cdn.example/x.png'), 'https://cdn.example/x.png');
  assert.equal(api.mediaUrl(SERVER, 'http://cdn.example/x.png'), 'http://cdn.example/x.png');
});

test('a server address with a port keeps working', () => {
  const { api } = apiHarness();
  const server = { ...SERVER, url: 'https://box.example:8443' };
  assert.equal(api.mediaUrl(server, '/api/media/x.png?sig=1'), 'https://box.example:8443/api/media/x.png?sig=1');
});

// The whole path a message takes: real `marked` lexer, the real Markdown component, resolveUrl = mediaUrl as ChatView sets it.
function renderedImageUris(text: string): string[] {
  const { api } = apiHarness();
  const require = createRequire(import.meta.url);
  const out: string[] = [];
  const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : fallback, apply: () => fallback });
  const walk = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Image' && node.props?.source?.uri !== undefined) out.push(node.props.source.uri);
    walk(node.props?.children);
  };
  // Function components are called straight away, so the returned tree is plain objects.
  const jsx = (type: any, props: any) => typeof type === 'function' ? type(props) : { type, props };
  const modules: any = {
    react: { memo: (fn: any) => fn, useMemo: (fn: any) => fn(), useState: (v: any) => [v, () => {}], Fragment: 'Fragment' },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'expo-image': { Image: 'Image' }, marked: require('marked'),
    'react-native': { Linking: {}, Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
  };
  const exports: any = {};
  const source = readFileSync(new URL('../src/components/Markdown.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText,
    { exports, require: (id: string) => modules[id] ?? fallback, console });
  const resolveUrl = (url: string) => api.mediaUrl(SERVER, url);
  walk(exports.Markdown({ text, resolveUrl }));
  return out;
}

test('a message with a hostile image destination makes the image loader request nothing off the paired server', () => {
  const ok = renderedImageUris('![ok](/api/media/abc/pic.png?sig=1)');
  assert.deepEqual(ok, ['https://box.example/api/media/abc/pic.png?sig=1'], 'the harness must really reach the Image element');
  for (const href of ['@evil.example/px.png', '%2f@evil.example/px.png', '//evil.example/px.png']) {
    const uris = renderedImageUris(`![x](${href})`);
    assert.equal(uris.length, 1, `${href} should still render one Image element`);
    for (const uri of uris) {
      assert.ok(staysOnServer(uri), `${href} rendered ${uri}`);
      if (!uri.startsWith(ORIGIN)) assert.ok(!uri.includes(SERVER.token));
    }
  }
});
