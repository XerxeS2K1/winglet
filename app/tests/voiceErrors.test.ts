import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const mod: any = (() => { const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/live-voice/voiceErrors.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
  return exports; })();

const unreachable = "Can't reach your Hermes server. Check that the gateway is running.";

test('each failing step names itself and keeps the cause', () => {
  assert.equal(mod.stepError('transcribe', unreachable), `Couldn't turn your speech into text. ${unreachable}`);
  assert.equal(mod.stepError('speak', 'Session expired.'), "Couldn't play the reply. Session expired.");
  assert.equal(mod.stepError('openSession', unreachable), `Couldn't start the voice session. ${unreachable}`);
});

test('capture and delivery messages are already specific and stay as they are', () => {
  assert.equal(mod.stepError('listen', 'Microphone permission was denied.'), 'Microphone permission was denied.');
  assert.equal(mod.stepError('send', 'Delivery was not confirmed.'), 'Delivery was not confirmed.');
});

test('an empty cause gives just the step, and a message is never prefixed twice', () => {
  assert.equal(mod.stepError('speak', ''), "Couldn't play the reply.");
  assert.equal(mod.stepError('speak', "  Couldn't play the reply. Try again. "), "Couldn't play the reply. Try again.");
});
