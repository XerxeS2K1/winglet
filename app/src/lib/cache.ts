import { SQLiteStorage } from 'expo-sqlite/kv-store';
import { gcm } from '@noble/ciphers/aes.js';
import { getRandomBytes } from 'expo-crypto';
import { b64d, b64e } from './crypto';
import { getItem, setItem } from './storage';

// Native chats, drafts and unsent messages are sealed before reaching SQLite. The device key lives
// beside the pairing credentials in the OS keychain; the browser has its own IndexedDB adapter.
const db = new SQLiteStorage('winglet-cache');
const KEY = 'winglet.cache-key.v1';
const PREFIX = 'winglet-cache:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let deviceKey: Uint8Array | undefined;
let migrated = false;
let queue: Promise<unknown> = Promise.resolve();
let status: 'ready' | 'unavailable' = 'ready';
const listeners = new Set<() => void>();

export function getCacheStatus() { return status; }
export function subscribeCacheStatus(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function setStatus(next: typeof status) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

// Migration, saves and removal share one queue, so an older migration/read can never replace a
// newer draft or resurrect a removed bot. A rejected operation must not block subsequent saves.
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

function seal(key: string, raw: string): string {
  const nonce = getRandomBytes(12);
  const ciphertext = gcm(deviceKey!, nonce, encoder.encode(`${PREFIX}${key}`)).encrypt(encoder.encode(raw));
  return `${PREFIX}${b64e(nonce)}:${b64e(ciphertext)}`;
}

function open(key: string, raw: string): string {
  if (!raw.startsWith(PREFIX)) throw new Error('Unsealed cache entry');
  const [nonce, ciphertext] = raw.slice(PREFIX.length).split(':');
  return decoder.decode(gcm(deviceKey!, b64d(nonce), encoder.encode(`${PREFIX}${key}`)).decrypt(b64d(ciphertext)));
}

async function ready(): Promise<void> {
  if (migrated) return;
  const keys = await db.getAllKeysAsync();
  if (!deviceKey) {
    const saved = await getItem(KEY);
    if (saved) {
      const bytes = b64d(saved);
      if (bytes.length !== 32) throw new Error('Invalid cache key');
      deviceKey = bytes;
    } else {
      // A restored database can outlive its keychain entry. Only an explicit reset may discard it.
      for (const key of keys) {
        if ((await db.getItemAsync(key))?.startsWith(PREFIX)) {
          setStatus('unavailable');
          throw new Error('Cache key unavailable');
        }
      }
      const bytes = getRandomBytes(32);
      await setItem(KEY, b64e(bytes));
      deviceKey = bytes;
    }
  }
  // Existing installations keep their drafts and outbox. Interrupted migrations resume safely;
  // already sealed entries stay untouched, and malformed legacy rows remain unreadable.
  for (const key of keys) {
    const raw = await db.getItemAsync(key);
    if (raw === null || raw.startsWith(PREFIX)) continue;
    try { JSON.parse(raw); } catch { await db.removeItemAsync(key); continue; }
    await db.setItemAsync(key, seal(key, raw));
  }
  migrated = true;
  setStatus('ready');
}

/** Probe on the storage screen even if no cache operation has run yet. */
export async function checkCacheStatus(): Promise<void> {
  try { await ordered(ready); } catch { /* live use remains available */ }
}

/** Explicitly discard offline storage and create a new key, serialized with all cache work. */
export async function resetCache(): Promise<void> {
  await ordered(async () => {
    setStatus('unavailable');
    deviceKey = undefined;
    migrated = false;
    const bytes = getRandomBytes(32);
    for (const key of await db.getAllKeysAsync()) await db.removeItemAsync(key);
    await setItem(KEY, b64e(bytes));
    deviceKey = bytes;
    await ready();
  });
}

export async function cacheGet<T>(key: string, fallback: T): Promise<T> {
  try {
    return await ordered(async () => {
      await ready();
      const raw = await db.getItemAsync(key);
      return raw ? (JSON.parse(open(key, raw)) as T) : fallback;
    });
  } catch {
    return fallback;
  }
}

/** Durable handoffs must learn when storage failed rather than silently treating it as absent. */
export async function cacheGetStrict<T>(key: string, fallback: T): Promise<T> {
  const raw = await ordered(async () => { await ready(); return db.getItemAsync(key); });
  return raw ? (JSON.parse(open(key, raw)) as T) : fallback;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try { await saveCache(key, value, false); }
  catch { /* a full or unavailable cache cannot prevent live use */ }
}

export async function cacheRemove(prefix: string): Promise<void> {
  try {
    await ordered(async () => {
      const keys = await db.getAllKeysAsync();
      for (const key of keys) if (key.startsWith(prefix)) await db.removeItemAsync(key);
    });
  } catch { /* ignore */ }
}

/** Durable replay checkpoints must learn when storage failed. */
export async function cacheSetStrict(key: string, value: unknown): Promise<void> {
  await saveCache(key, value, true);
}

// Native save diagnostics are explicit opt-in (even in development). Use the existing build flag,
// but do not import perf.ts: native cache harnesses deliberately stub only storage/crypto imports.
const CACHE_PERF_ON = typeof process !== 'undefined' && process.env.EXPO_PUBLIC_WINGLET_PERF === '1';
const categories = ['msgs:', 'chats:', 'inbox:', 'outbox:', 'replay:', 'projects:', 'pet:'];
// totalMs is diagnostic-on elapsed (including byte counting), not unperturbed production cost.
// readyMs includes cold key setup and migration crypto/SQLite; syncMs is only this save's JSON + seal.
const stages = ['jsonMs', 'bytesMs', 'queueMs', 'readyMs', 'sealMs', 'sqliteMs', 'syncMs', 'totalMs'] as const;
type Stage = typeof stages[number];
type SaveTiming = { start: number; at: number; valid: boolean; category: number; strict: number; cold: number;
  messages: number; bytes: number; times: Record<Stage, number> };
// Fixed category x cold/steady x strict/best-effort space; no ids, values or samples retained.
const saveSummaries = new Map<number, Record<string, number>>();
function timingClock(): number | undefined {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : undefined;
  } catch { return; }
}
function beginSave(key: string, value: unknown, strict: boolean): SaveTiming | undefined {
  if (!CACHE_PERF_ON) return;
  try {
    const category = key.startsWith('msgs:') ? 1
      : key === 'drafts' ? 8 : key === 'draftFiles' ? 9 : key === 'replyTo' ? 10
      : Math.max(0, categories.findIndex((prefix) => key.startsWith(prefix)) + 1);
    const start = timingClock();
    if (start === undefined) return;
    return { start, at: start, valid: true, category, strict: Number(strict), cold: 0,
      messages: category === 1 && Array.isArray(value) ? value.length : 0, bytes: 0,
      times: { jsonMs: 0, bytesMs: 0, queueMs: 0, readyMs: 0, sealMs: 0, sqliteMs: 0, syncMs: 0, totalMs: 0 } };
  } catch { return; }
}
function markSave(t: SaveTiming | undefined, stage: Stage): void {
  if (!t || !t.valid) return;
  const now = timingClock();
  if (now === undefined) { t.valid = false; return; }
  t.times[stage] = Math.max(0, now - t.at);
  t.at = now;
}
function finishSave(t: SaveTiming | undefined, success: boolean): void {
  if (!t || !t.valid) return;
  try {
    const now = timingClock();
    // An unavailable/nonfinite reading discards the whole sample, never a plausible zero-time save.
    if (now === undefined) return;
    t.times.totalMs = Math.max(0, now - t.start);
    // Derived subset, not another elapsed stage to add to the reconciliation sum.
    t.times.syncMs = t.times.jsonMs + t.times.sealMs;
    const bucket = t.category * 4 + t.cold * 2 + t.strict;
    let s = saveSummaries.get(bucket);
    if (!s) {
      s = { category: t.category, cold: t.cold, strict: t.strict, count: 0, errors: 0,
        messagesTotal: 0, messagesMax: 0, bytesTotal: 0, bytesMax: 0 };
      for (const stage of stages) { s[`${stage}Total`] = 0; s[`${stage}Max`] = 0; }
      for (let i = 0; i < 12; i++) s[`totalBin${i}`] = 0;
      saveSummaries.set(bucket, s);
    }
    s.count++;
    // Disjoint total elapsed bins: <=1, <=2, <=4, ... <=1024, >1024 ms.
    const bin = t.times.totalMs <= 1 ? 0 : Math.min(11, Math.ceil(Math.log2(t.times.totalMs)));
    s[`totalBin${bin}`]++;
    s.errors += Number(!success);
    s.messagesTotal += t.messages;
    s.messagesMax = Math.max(s.messagesMax, t.messages);
    s.bytesTotal += t.bytes;
    s.bytesMax = Math.max(s.bytesMax, t.bytes);
    for (const stage of stages) {
      s[`${stage}Total`] += t.times[stage];
      s[`${stage}Max`] = Math.max(s[`${stage}Max`], t.times[stage]);
    }
    // First completion, then every ten per bucket. No per-token output or background timers.
    if (s.count === 1 || s.count % 10 === 0) console.log('[winglet-cache-perf]', { ...s });
  } catch { /* Diagnostics must never change storage success or failure. */ }
}
async function saveCache(key: string, value: unknown, strict: boolean): Promise<void> {
  const t = beginSave(key, value, strict);
  let success = false;
  try {
    let raw: string;
    try { raw = JSON.stringify(value); } finally { markSave(t, 'jsonMs'); }
    if (t) {
      // Extra UTF-8 encoding is diagnostic overhead, not JSON or seal cost. No retained bytes.
      try { t.bytes = encoder.encode(raw).length; } catch { /* diagnostic only */ }
      finally { markSave(t, 'bytesMs'); }
    }
    await ordered(async () => {
      markSave(t, 'queueMs');
      if (t) t.cold = Number(!migrated);
      try { await ready(); } finally { markSave(t, 'readyMs'); }
      let sealed: string;
      try { sealed = seal(key, raw); } finally { markSave(t, 'sealMs'); }
      try { await db.setItemAsync(key, sealed); } finally { markSave(t, 'sqliteMs'); }
    });
    success = true;
  } finally { finishSave(t, success); }
}
