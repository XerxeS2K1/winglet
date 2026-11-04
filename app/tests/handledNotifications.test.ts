import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/handledNotifications.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const { handledNoteTags, chatNoteTag, inboxNoteTag } = exports;
const item = (id: string, kind: string, status: string) => ({ id, kind, status });

test('tags match the ones the server sends', () => {
  assert.equal(chatNoteTag('general'), 'chat-general');
  assert.equal(inboxNoteTag('i1'), 'inbox-i1');
});

test('answered or expired approvals and questions are handled', () => {
  assert.deepEqual([...handledNoteTags([item('a', 'question', 'resolved'), item('b', 'approval', 'expired')])], ['inbox-a', 'inbox-b']);
});

test('waiting cards keep their notification', () => {
  assert.deepEqual([...handledNoteTags([item('a', 'question', 'pending'), item('b', 'approval', 'pending')])], []);
});

test('results are never handled by status: they are cleared when opened', () => {
  assert.deepEqual([...handledNoteTags([item('r', 'result', 'resolved')])], []);
});

test('a long history sends at most 200 tags', () => {
  const many = Array.from({ length: 300 }, (_, i) => item(`i${i}`, 'question', 'resolved'));
  assert.equal(handledNoteTags(many).length, 200);
});
