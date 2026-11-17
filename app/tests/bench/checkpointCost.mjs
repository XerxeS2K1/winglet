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
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

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

/**
 * The case the chunking is for: one long chat and one new message at a time, comparing the v2 layout
 * (one record per chat holding the whole message array) with the v3 layout (ordered ~64 KB chunks).
 */
function longChat(nMessages = 5000, textLen = 430, rounds = 7) {
  const { planCheckpoint } = loadCheckpointModule();
  const slices = history(1, nMessages, textLen);
  const cursor = (n) => ({ scope: 'scope', epoch: 'epoch', cursor: n });
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

  // (a) v2, as shipped at 74e5096: every message rewrites the chat's whole array as one record.
  const v2 = [];
  const v2Bytes = [];
  for (let i = 0; i < rounds; i++) {
    const page = [...slices.messages.general, {
      id: `live-${i}`, position: nMessages + i, chat_id: 'general', role: 'bot', text: 'y'.repeat(textLen),
      status: 'final', meta: {}, created_at: 1, updated_at: 2000 + i,
    }];
    const started = performance.now();
    v2Bytes.push(seal('replay:s:m:general', JSON.stringify({ messages: page, deleted: [] })));
    v2.push(performance.now() - started);
  }

  // (b) v3: the first save after the upgrade writes every chunk once; after that a new message is the
  // tail chunk, its tombstones only when they change, and the cursor.
  const firstPlan = planCheckpoint('s', slices, cursor(0));
  const firstStarted = performance.now();
  let chunkBytes = 0;
  let meta = 0;
  for (const item of firstPlan.write) {
    chunkBytes += seal(item.key, JSON.stringify(item.value));
    if (item.key === 'replay:s:v3:meta') meta = JSON.stringify(item.value).length;
  }
  const first = performance.now() - firstStarted;
  const chunks = firstPlan.saved.chats.general.keys.length;
  let saved = firstPlan.saved;

  const v3 = [];
  const v3Bytes = [];
  let wrote = [];
  for (let i = 0; i < rounds; i++) {
    const page = [...slices.messages.general, {
      id: `live-${i}`, position: nMessages + i, chat_id: 'general', role: 'bot', text: 'y'.repeat(textLen),
      status: 'final', meta: {}, created_at: 1, updated_at: 2000 + i,
    }];
    slices.messages = { ...slices.messages, general: page };
    const started = performance.now();
    const plan = planCheckpoint('s', slices, cursor(i + 1), saved);
    let bytes = 0;
    for (const item of plan.write) bytes += seal(item.key, JSON.stringify(item.value));
    v3.push(performance.now() - started);
    v3Bytes.push(bytes);
    if (i === 0) wrote = plan.write.map((item) => item.key);
    saved = plan.saved;
  }

  console.log(`--- one chat of ${nMessages} messages (${kib(JSON.stringify(slices.messages.general).length)} of JSON) ---`);
  console.log(`  v2 whole-page save, one new message: ${kib(median(v2Bytes))} sealed, ${median(v2).toFixed(1)} ms`);
  console.log(`  v3 tail-chunk save, one new message: ${kib(median(v3Bytes))} sealed, ${median(v3).toFixed(1)} ms`);
  console.log(`  ratio: ${(median(v2Bytes) / median(v3Bytes)).toFixed(0)}x fewer bytes, `
    + `${(median(v2) / median(v3)).toFixed(0)}x less time per message`);
  console.log(`  v3 first save (the upgrade): ${kib(chunkBytes)} in ${chunks} chunks, ${first.toFixed(1)} ms`);
  console.log(`  v3 meta record naming all ${chunks} chunks: ${meta} bytes of JSON`);
  console.log(`  v3 records written by one new message: ${wrote.join(', ')}`);
  return { v2Bytes: median(v2Bytes), v3Bytes: median(v3Bytes), v2: median(v2), v3: median(v3), meta, chunks };
}

console.log('--- the case the chunking is for: a 5,000-message chat, one message at a time ---');
longChat();

/**
 * The scaling end: a chat long enough that the plan itself, and the number of records a restore fans out
 * over, become the cost. This is the bulk case — one chat loaded in one go, cut at the size its whole
 * history needs (see MAX_CHUNKS in checkpoint.ts) — and `planCostGrown` below prints the same history grown
 * by appends beside it, because the two paths reach their chunk count by different routes. Times are the
 * plan alone (no sealing), which is what a live save spends on the JS thread before any encryption.
 */
function planCost(nMessages = 100000, textLen = 430, rounds = 7) {
  const { planCheckpoint, MAX_CHUNKS, CHUNK_TARGET_BYTES } = loadCheckpointModule();
  const slices = history(1, nMessages, textLen);
  const cursor = (n) => ({ scope: 'scope', epoch: 'epoch', cursor: n });
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  const total = JSON.stringify(slices.messages.general).length;

  let started = performance.now();
  const firstPlan = planCheckpoint('s', slices, cursor(0));
  const firstMs = performance.now() - started;
  const chunks = firstPlan.saved.chats.general.keys.length;
  let saved = firstPlan.saved;

  const planMs = [];
  const bytes = [];
  let wrote = 0;
  for (let i = 0; i < rounds; i++) {
    const page = [...slices.messages.general, {
      id: `live-${i}`, position: nMessages + i, chat_id: 'general', role: 'bot', text: 'y'.repeat(textLen),
      status: 'final', meta: {}, created_at: 1, updated_at: 5000 + i,
    }];
    slices.messages = { ...slices.messages, general: page };
    started = performance.now();
    const plan = planCheckpoint('s', slices, cursor(i + 1), saved);
    planMs.push(performance.now() - started);
    let sealed = 0;
    for (const item of plan.write) sealed += seal(item.key, JSON.stringify(item.value));
    bytes.push(sealed);
    if (i === 0) wrote = plan.write.length;
    saved = plan.saved;
  }

  console.log(`--- one chat of ${nMessages} messages (${(total / 1e6).toFixed(1)} MB of JSON) ---`);
  console.log(`  chunks: ${chunks} (cap ${MAX_CHUNKS}, base target ${kib(CHUNK_TARGET_BYTES)} -> target ${kib(saved.chats.general.target ?? CHUNK_TARGET_BYTES)})`);
  console.log(`  first save (the upgrade) plans in ${firstMs.toFixed(1)} ms, before any sealing`);
  console.log(`  one new message: plan ${median(planMs).toFixed(2)} ms, ${wrote} records, ${kib(median(bytes))} sealed`);
  return { chunks, planMs: median(planMs), firstMs, bytes: median(bytes),
    target: saved.chats.general.target ?? CHUNK_TARGET_BYTES, cap: MAX_CHUNKS };
}

console.log('--- plan cost at 5,000 messages (the device-sized case above) ---');
planCost(5000);

console.log('--- the scaling end: a 100,000-message chat, one message at a time ---');
const bulk = planCost();

/**
 * The same history, grown the way a real chat grows: from empty, by saves that append a batch of messages.
 * This is the case the cap used to miss — the append path kept the target it started with and never asked
 * for a bigger one, so a chat grown to 100,000 messages ended at 1,176 chunks of 64 KiB, 4.6x the cap.
 * Printed beside the bulk load so the two numbers can be read together.
 */
function planCostGrown(nMessages = 100000, batch = 500, textLen = 430) {
  const { planCheckpoint, MAX_CHUNKS, CHUNK_TARGET_BYTES } = loadCheckpointModule();
  const cursor = (n) => ({ scope: 'scope', epoch: 'epoch', cursor: n });
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  const message = (i) => ({ id: `general-${i}`, position: i, chat_id: 'general', role: 'bot',
    text: 'x'.repeat(textLen), status: 'final', meta: {}, created_at: 1, updated_at: i + 1 });
  const slices = { chats: { general: { id: 'general', kind: 'chat', title: 'general' } },
    messages: { general: [] }, deleted: {}, loaded: {}, inbox: {}, pending: 0, paused: null,
    me: undefined, projects: undefined, tasks: {} };

  let saved;
  let worst = 0;
  let saves = 0;
  const recuts = [];
  const started = performance.now();
  while (slices.messages.general.length < nMessages) {
    const page = slices.messages.general;
    const grown = [...page, ...Array.from({ length: Math.min(batch, nMessages - page.length) },
      (_, k) => message(page.length + k))];
    slices.messages = { ...slices.messages, general: grown };
    const plan = planCheckpoint('s', slices, cursor(++saves), saved);
    const count = plan.saved.chats.general.keys.length;
    worst = Math.max(worst, count);
    const wrote = plan.write.filter((item) => item.key.includes(':c:')).length;
    // A whole-chat recut rewrites every chunk; an ordinary append writes the one tail chunk, and a batch
    // append writes the few chunks it touched. The first save is a new chat cut whole, not a recut.
    if (saves > 1 && wrote === count && count > 1) recuts.push({ at: grown.length, count });
    saved = plan.saved;
  }
  const growthMs = performance.now() - started;

  // One more message, appended to the chat as it now stands: what a live save costs after the growth.
  const page = slices.messages.general;
  slices.messages = { ...slices.messages, general: [...page, message(page.length)] };
  const appended = performance.now();
  const plan = planCheckpoint('s', slices, cursor(++saves), saved);
  const planMs = performance.now() - appended;
  let sealedBytes = 0;
  for (const item of plan.write) sealedBytes += seal(item.key, JSON.stringify(item.value));
  const wrote = plan.write.filter((item) => item.key.includes(':c:')).length;

  console.log(`--- the same ${nMessages.toLocaleString('en-GB')}-message chat grown live: ${batch} messages per save, from empty ---`);
  console.log(`  chunks: ${saved.chats.general.keys.length} (cap ${MAX_CHUNKS}, base target ${kib(CHUNK_TARGET_BYTES)} -> target ${kib(saved.chats.general.target ?? CHUNK_TARGET_BYTES)})`);
  console.log(`  most chunks any save left: ${worst}; whole-chat recuts while growing: ${recuts.length}`
    + (recuts.length ? ` (at ${recuts.map((r) => `${r.at} messages -> ${r.count} chunks`).join(', ')})` : ''));
  console.log(`  growth: ${saves} saves, ${growthMs.toFixed(0)} ms of planning in total`);
  console.log(`  one message appended after that growth: plan ${planMs.toFixed(2)} ms, `
    + `${wrote} chunk record${wrote === 1 ? '' : 's'}, ${kib(sealedBytes)} sealed`);
  return { chunks: saved.chats.general.keys.length, worst, recuts: recuts.length, planMs, sealedBytes,
    target: saved.chats.general.target ?? CHUNK_TARGET_BYTES };
}

console.log('--- the grown-live case, for the two numbers side by side ---');
const grown = planCostGrown();
console.log('--- side by side: bulk load ' + `${bulk.chunks} chunks of ${kib(bulk.target)}, `
  + `grown live ${grown.chunks} chunks of ${kib(grown.target)}, cap ${bulk.cap} on both paths ---`);

