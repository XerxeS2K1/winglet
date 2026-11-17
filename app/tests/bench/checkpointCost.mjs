/**
 * What one replay checkpoint save costs, before and after the split, on a synthetic large history.
 *
 * The numbers this prints are the ones quoted in the design note. It measures the two things that
 * made the phone freeze: the bytes that go through AES-GCM into SQLite for one save, and the
 * milliseconds of sealing them on the JS thread. Sealing runs in-process with @noble/ciphers and the
 * same parameters as src/lib/cache.ts (AES-256-GCM, 12-byte nonce, `winglet-cache:v1:<key>` as AAD),
 * so the "before" figure matches what the phone was actually doing per event.
 *
 * Run from app/:  node tests/bench/checkpointCost.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { gcm } from '@noble/ciphers/aes.js';

const PREFIX = 'winglet-cache:v1:';
const encoder = new TextEncoder();
const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
const nonce = () => globalThis.crypto.getRandomValues(new Uint8Array(12));

/** Seal exactly as cache.ts does; returns the number of characters SQLite stores. */
function seal(cacheKey, raw) {
  const iv = nonce();
  const ciphertext = gcm(key, iv, encoder.encode(`${PREFIX}${cacheKey}`)).encrypt(encoder.encode(raw));
  return PREFIX.length + Buffer.from(iv).toString('base64').length + 1 + Buffer.from(ciphertext).toString('base64').length;
}

function loadCheckpointModule() {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../../src/features/event-replay/checkpoint.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: () => ({}) });
  return exports;
}

function history(nChats, nMessages, textLen) {
  const chats = {}, messages = {}, deleted = {}, tasks = {};
  for (let c = 0; c < nChats; c++) {
    const id = c === 0 ? 'general' : `chat${c}`;
    chats[id] = { id, kind: 'chat', title: id };
    messages[id] = Array.from({ length: nMessages }, (_, i) => ({
      id: `${id}-${i}`, position: i, chat_id: id, role: 'bot', text: 'x'.repeat(textLen),
      status: 'final', meta: {}, created_at: 1, updated_at: i + 1,
    }));
  }
  return { chats, messages, deleted, loaded: {}, inbox: {}, pending: 0, paused: null, me: undefined,
    projects: undefined, tasks };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function sealed(slices, cursor) {
  // The pre-split checkpoint: one value holding every chat and every message.
  return seal(`replay:s`, JSON.stringify({ cursor, state: slices }));
}

function run(nChats, nMessages, textLen, events, rounds = 7) {
  const { planCheckpoint } = loadCheckpointModule();
  const slices = history(nChats, nMessages, textLen);
  const cursor = (n) => ({ scope: 'scope', epoch: 'epoch', cursor: n });

  // Before: every event rewrites and reseals the whole state.
  const before = [];
  const beforeBytes = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    beforeBytes.push(sealed(slices, i));
    before.push(performance.now() - started);
  }

  // After: the first save after upgrade writes everything once, then each event writes one chat.
  const opened = [];
  let saved;
  const firstStarted = performance.now();
  let firstBytes = 0;
  for (const item of planCheckpoint('s', slices, cursor(0)).write) firstBytes += seal(item.key, JSON.stringify(item.value));
  opened.push(performance.now() - firstStarted);
  saved = planCheckpoint('s', slices, cursor(0)).saved;

  const after = [], afterBytes = [];
  for (let i = 1; i <= rounds; i++) {
    // One live event: the bot's answer in `general` arrives a token at a time, so its array is new.
    const page = slices.messages.general;
    slices.messages = { ...slices.messages, general: [...page, {
      id: `live-${i}`, position: page.length, chat_id: 'general', role: 'bot', text: 'y'.repeat(textLen),
      status: 'streaming', meta: {}, created_at: 1, updated_at: 1000 + i }] };
    const started = performance.now();
    const plan = planCheckpoint('s', slices, cursor(i), saved);
    let bytes = 0;
    for (const item of plan.write) bytes += seal(item.key, JSON.stringify(item.value));
    after.push(performance.now() - started);
    afterBytes.push(bytes);
    saved = plan.saved;
  }

  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`history: ${nChats} chats x ${nMessages} messages x ${textLen}-char text`);
  console.log(`  before  one save: ${kib(median(beforeBytes))} sealed, ${median(before).toFixed(1)} ms to seal`);
  console.log(`  after   first save (upgrade): ${kib(firstBytes)} sealed, ${median(opened).toFixed(1)} ms to seal`);
  console.log(`  after   one event: ${kib(median(afterBytes))} sealed, ${median(after).toFixed(1)} ms to seal`);
  console.log(`  ratio: ${(median(beforeBytes) / median(afterBytes)).toFixed(1)}x fewer bytes, `
    + `${(median(before) / median(after)).toFixed(1)}x less sealing per event`);
  console.log(`  a burst of ${events} queued events: before ${kib(median(beforeBytes) * events)}, `
    + `after ${kib(median(afterBytes))} (one coalesced save)`);
  return { beforeBytes: median(beforeBytes), afterBytes: median(afterBytes), before: median(before), after: median(after) };
}

console.log('--- the phone-sized history that was measured on the device (3 MB, 1.5 s per save) ---');
run(10, 300, 500, 30);
console.log('--- a smaller history, to show the cost follows what changed ---');
run(3, 60, 200, 30);
