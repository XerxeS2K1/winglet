import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/commands.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}), Map, Date });
const { needsSignature } = exports;

test('needsSignature covers the commands that approve or switch approvals off', () => {
  for (const t of ['/approve once', '/approve', '/YOLO', ' /yolo ', '/yolo@winglet', '/approvals off', '/approvals'])
    assert.equal(needsSignature(t), true, t);
  for (const t of ['/approved', '/model gpt', '/help', 'yolo', 'say /yolo', '/approvalsx', '/new'])
    assert.equal(needsSignature(t), false, t);
});
