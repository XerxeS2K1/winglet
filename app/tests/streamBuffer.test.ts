import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function load() {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/lib/streamBuffer.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: () => ({}) });
  return exports;
}
const { createStreamBuffer, canCoalesce, FRAME_MS } = load();

function harness() {
  const log: string[] = [];
  const frames: Array<{ fn: () => void; live: boolean; ms: number }> = [];
  const buffer = createStreamBuffer((s: string, c: string, m: any) => log.push(`${s}/${c}/${m.id}:${m.text}`), {
    set: (fn: () => void, ms: number) => { frames.push({ fn, live: true, ms }); return frames.length - 1; },
    clear: (id: number) => { frames[id].live = false; },
  });
  const frame = () => { const f = frames.find((x) => x.live); if (f) { f.live = false; f.fn(); } return !!f; };
  return { log, buffer, frame, frames };
}
const m = (id: string, text: string, updated_at = 1) => ({ id, text, updated_at });

test('what may wait: only an update of a bot message that is still streaming', () => {
  const bot = (status: string, role = 'bot') => ({ type: 'message.update', chat_id: 'c', message: { role, status } });
  assert.equal(canCoalesce(bot('streaming')), true);
  for (const status of ['final', 'failed', 'pending', 'queued']) assert.equal(canCoalesce(bot(status)), false, status);
  assert.equal(canCoalesce(bot('streaming', 'user')), false);
  assert.equal(canCoalesce(bot('streaming', 'system')), false);
  assert.equal(canCoalesce({ ...bot('streaming'), type: 'message.new' }), false);
  assert.equal(canCoalesce({ type: 'typing', chat_id: 'c' }), false);
  assert.equal(canCoalesce({ ...bot('streaming'), chat_id: undefined }), false);
  assert.equal(canCoalesce(undefined), false);
  assert.equal(FRAME_MS, 33);
});

test('the first update is applied at once; the rest of the frame wait, newest only, and one write ends the frame', () => {
  const h = harness();
  h.buffer.add('s', 'c', m('a', '1'));
  assert.deepEqual(h.log, ['s/c/a:1']);
  for (const t of ['2', '3', '4']) h.buffer.add('s', 'c', m('a', t, Number(t)));
  assert.deepEqual(h.log, ['s/c/a:1']);
  assert.equal(h.buffer.pending(), 1);
  h.frame();
  assert.deepEqual(h.log, ['s/c/a:1', 's/c/a:4']);
  assert.equal(h.frames.length, 2, 'a stream that continues keeps a frame open');
  h.buffer.add('s', 'c', m('a', '5', 5));
  h.frame();
  assert.deepEqual(h.log.at(-1), 's/c/a:5');
  h.frame(); // nothing waited: the frame closes without opening another
  assert.equal(h.frame(), false);
});

test('an update older than the one waiting is dropped', () => {
  const h = harness();
  h.buffer.add('s', 'c', m('a', '1', 1));
  h.buffer.add('s', 'c', m('a', '3', 3));
  h.buffer.add('s', 'c', m('a', '2', 2));
  h.buffer.flush();
  assert.deepEqual(h.log, ['s/c/a:1', 's/c/a:3']);
});

test('another message in the same chat never overtakes the one waiting', () => {
  const h = harness();
  h.buffer.add('s', 'c', m('a', '1'));
  h.buffer.add('s', 'c', m('a', '2', 2));
  h.buffer.add('s', 'c', m('b', 'x', 3));
  assert.deepEqual(h.log, ['s/c/a:1', 's/c/a:2']);
  h.buffer.flush();
  assert.deepEqual(h.log, ['s/c/a:1', 's/c/a:2', 's/c/b:x']);
});

test('flush applies everything waiting, in the order it began waiting, and cancels the frame', () => {
  const h = harness();
  h.buffer.add('s', 'c1', m('a', '1'));
  h.buffer.add('s', 'c1', m('a', '2', 2));
  h.buffer.add('s', 'c2', m('b', '1'));
  h.buffer.add('s', 'c2', m('b', '2', 2));
  h.buffer.flush();
  assert.deepEqual(h.log, ['s/c1/a:1', 's/c1/a:2', 's/c2/b:2'] /* one frame for all chats: c2's first update waits for it too */);
  assert.equal(h.buffer.pending(), 0);
  assert.equal(h.frames.filter((f) => f.live).length, 0, 'no frame left to fire');
  h.buffer.flush();
  assert.equal(h.log.length, 3, 'a second flush applies nothing');
});
