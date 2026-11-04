import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/launchLink.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const { launchPath } = exports;

test('a notification for a chat opens that chat', () => {
  assert.equal(launchPath('winglet://chat/abc123/general'), '/chat/abc123/general');
  assert.equal(launchPath('winglet-dev://chat/abc123~bot/c%2F1'), '/chat/abc123~bot/c%2F1');
});

test('a notification for an inbox card opens that card', () => {
  assert.equal(launchPath('winglet://inbox?server=abc&item=i1'), '/inbox?server=abc&item=i1');
});

test('any other start is left alone', () => {
  for (const url of [null, undefined, '', 'winglet://', 'winglet:///', 'winglet://pair?token=x', 'winglet://chat/', 'https://example.com/chat/a/b', 'other://chat/a/b'])
    assert.equal(launchPath(url), null);
});
