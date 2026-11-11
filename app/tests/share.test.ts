import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/share.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Math, Object });
const { fromShare, mergeDraft, shareTargets } = exports;

test('shared text and links become composer text', () => {
  assert.equal(fromShare(null, 10), null);
  assert.equal(fromShare({ text: '  ', files: [] }, 10), null);
  assert.equal(fromShare({ text: 'Look at this https://x.dev/a', webUrl: 'https://x.dev/a' }, 10).text, 'Look at this https://x.dev/a');
  assert.equal(fromShare({ text: null, webUrl: 'https://x.dev/a', meta: { title: 'A page' } }, 10).text, 'A page\nhttps://x.dev/a');
  assert.equal(fromShare({ text: 'https://x.dev/a', webUrl: 'https://x.dev/a', meta: { title: 'A page' } }, 10).text, 'A page\nhttps://x.dev/a');
});

test('shared files become picked files, within the limit', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `file:///c/${i}`, mimeType: i ? 'application/pdf' : 'image/jpeg', fileName: i ? `doc${i}.pdf` : null, size: 10 }));
  const shared = fromShare({ files }, 10);
  assert.equal(shared.files.length, 10);
  assert.equal(shared.dropped, 2);
  assert.equal(shared.text, '');
  assert.deepEqual({ ...shared.files[0] }, { uri: 'file:///c/0', mime: 'image/jpeg', name: 'shared-1.jpg', size: 10, isImage: true });
  assert.equal(shared.files[1].name, 'doc1.pdf');
  assert.equal(fromShare({ files: [{ path: 'file:///x', mimeType: null }] }, 10).files[0].mime, 'application/octet-stream');
});

test('shared text joins an existing draft instead of replacing it', () => {
  assert.equal(mergeDraft('', 'hi'), 'hi');
  assert.equal(mergeDraft('half typed  ', 'https://x.dev'), 'half typed\n\nhttps://x.dev');
  assert.equal(mergeDraft('keep me', ''), 'keep me');
});

test("a bot offers its main chat first, then recent chats, never Reports or someone else's chat", () => {
  const chats = {
    general: { id: 'general', title: 'General', kind: 'chat', updated_at: 1 },
    home: { id: 'home', title: 'Reports', kind: 'home', updated_at: 9 },
    a: { id: 'a', title: 'Trip', kind: 'chat', updated_at: 5 },
    b: { id: 'b', title: 'Taxes', kind: 'chat', updated_at: 7 },
    alex: { id: 'm-alex', title: 'Alex', kind: 'chat', updated_at: 8, owner_device: 'alex' },
  };
  assert.deepEqual(Array.from(shareTargets(chats, 'general', 'me'), (c: any) => c.id), ['general', 'b', 'a']);
  assert.deepEqual(Array.from(shareTargets(chats, 'general', 'me', 1), (c: any) => c.id), ['general', 'b']);
  assert.equal(shareTargets(undefined, 'general', 'me')[0].title, 'General');
  // A member sees their own chat as their main one.
  assert.deepEqual(Array.from(shareTargets(chats, 'm-alex', 'alex'), (c: any) => c.id), ['m-alex', 'b', 'a', 'general']);
});

test("file names with #, ? or % survive as a URI; other URIs don't change", () => {
  const { fileUri } = exports;
  assert.equal(fileUri('file:///data/cache/Invoice #123?.pdf'), 'file:///data/cache/Invoice %23123%3F.pdf');
  assert.equal(fileUri('file:///data/cache/100%.png'), 'file:///data/cache/100%25.png');
  assert.equal(fileUri('file:///data/cache/plain name.jpg'), 'file:///data/cache/plain name.jpg');
  assert.equal(fileUri('content://media/external/images/1#x'), 'content://media/external/images/1#x');
  assert.equal(fromShare({ files: [{ path: 'file:///c/a#b.pdf', mimeType: 'application/pdf', fileName: 'a#b.pdf' }] }, 10).files[0].uri, 'file:///c/a%23b.pdf');
});

test("before the server answers, a member's main chat is their own, not General", () => {
  const { mainChat } = exports;
  const chats = { general: { id: 'general' }, 'm-dev1': { id: 'm-dev1' } };
  assert.equal(mainChat('m-dev1', chats, 'dev1'), 'm-dev1');
  assert.equal(mainChat(undefined, chats, 'dev1'), 'm-dev1');
  assert.equal(mainChat(undefined, chats, 'owner'), 'general');
  assert.equal(mainChat(undefined, undefined, 'dev1'), 'general');
});
