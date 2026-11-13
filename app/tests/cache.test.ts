import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { gcm } from '@noble/ciphers/aes.js';
import ts from 'typescript';

function harness(rows = new Map<string, string>(), secrets = new Map<string, string>(), diagnostic: { flag?: string; brokenLog?: boolean; brokenClock?: boolean; missingClock?: 'performance' | 'now'; clock?: (read: number, now: number) => number; encodeMs?: number; readyMs?: number; sealMs?: number } = {}) {
  const logs: any[] = [];
  let clockReads = 0;
  let now = 0;
  const exports: any = {};
  let keychainAvailable = true;
  let beforeWrite: (key: string) => Promise<void> = async () => {};
  const modules: any = {
    'expo-sqlite/kv-store': { SQLiteStorage: class {
      async getItemAsync(key: string) { return rows.get(key) ?? null; }
      async getAllKeysAsync() { return [...rows.keys()]; }
      async setItemAsync(key: string, value: string) { await beforeWrite(key); rows.set(key, value); }
      async removeItemAsync(key: string) { rows.delete(key); }
    } },
    '@noble/ciphers/aes.js': { gcm },
    'expo-crypto': { getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) },
    './crypto': {
      b64e: (bytes: Uint8Array) => { now += diagnostic.sealMs ?? 0; return Buffer.from(bytes).toString('base64url'); },
      b64d: (text: string) => new Uint8Array(Buffer.from(text, 'base64url')),
    },
    './storage': {
      getItem: async (key: string) => {
        now += diagnostic.readyMs ?? 0;
        if (!keychainAvailable) throw new Error('Keychain unavailable');
        return secrets.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        if (!keychainAvailable) throw new Error('Keychain unavailable');
        secrets.set(key, value);
      },
    },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/cache.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => modules[id],
    TextEncoder: class extends TextEncoder {
      encode(text?: string) { now += diagnostic.encodeMs ?? 0; return super.encode(text); }
    }, TextDecoder, Uint8Array,
    process: { env: { EXPO_PUBLIC_WINGLET_PERF: diagnostic.flag } },
    performance: diagnostic.missingClock === 'performance' ? undefined : diagnostic.missingClock === 'now' ? {} : {
      now: () => { clockReads++; if (diagnostic.brokenClock) throw new Error('clock'); return diagnostic.clock ? diagnostic.clock(clockReads, now) : now; },
    },
    console: { log: (tag: string, data: any) => { if (diagnostic.brokenLog) throw new Error('logger'); logs.push([tag, structuredClone(data)]); } },
  });
  return { rows, secrets, logs, clockReads: () => clockReads, advance: (ms: number) => { now += ms; },
    get: exports.cacheGet, set: exports.cacheSet, strict: exports.cacheSetStrict, remove: exports.cacheRemove,
    status: exports.getCacheStatus, subscribe: exports.subscribeCacheStatus, reset: exports.resetCache,
    keychain: (available: boolean) => { keychainAvailable = available; },
    writes: (fn: typeof beforeWrite) => { beforeWrite = fn; } };
}

test('native cache migrates all legacy rows without losing drafts or unsent messages', async () => {
  const draft = { 'bot:chat': 'Private draft 🔒' };
  const outbox = [{ client_id: 'keep-this-id', text: 'Unsent question', attachments: [{ id: 'file' }] }];
  const h = harness(new Map([['drafts', JSON.stringify(draft)], ['outbox:bot', JSON.stringify(outbox)]]));
  assert.deepEqual(structuredClone(await h.get('drafts', {})), draft);
  for (const value of h.rows.values()) {
    assert.ok(value.startsWith('winglet-cache:v1:'));
    assert.ok(!value.includes('Private') && !value.includes('Unsent'));
  }
  const restarted = harness(h.rows, h.secrets);
  assert.deepEqual(structuredClone(await restarted.get('outbox:bot', [])), outbox);
  assert.equal(h.secrets.size, 1);
});

test('cache uses a fresh nonce for every save and authenticates both bytes and record identity', async () => {
  const h = harness();
  await h.set('msgs:bot:one', ['A private answer']);
  const first = h.rows.get('msgs:bot:one')!;
  await h.set('msgs:bot:one', ['A private answer']);
  assert.notEqual(h.rows.get('msgs:bot:one'), first);
  h.rows.set('msgs:bot:two', first);
  assert.equal(await h.get('msgs:bot:two', 'unreadable'), 'unreadable', 'moving ciphertext between chats fails authentication');
  const parts = first.split(':');
  const bytes = Buffer.from(parts[3], 'base64url');
  bytes[0] ^= 1;
  parts[3] = bytes.toString('base64url');
  h.rows.set('msgs:bot:one', parts.join(':'));
  assert.equal(await h.get('msgs:bot:one', 'unreadable'), 'unreadable');
});

test('a keychain failure never falls back to writing plaintext and later saves can recover', async () => {
  const h = harness();
  h.keychain(false);
  await h.set('drafts', { text: 'Secret' });
  assert.equal(h.rows.size, 0);
  assert.equal(await h.get('drafts', 'offline'), 'offline');
  h.keychain(true);
  await h.set('drafts', { text: 'Recovered' });
  assert.deepEqual(structuredClone(await h.get('drafts', {})), { text: 'Recovered' });
});

test('a missing device key cannot replace an encrypted outbox with new empty data', async () => {
  const h = harness();
  await h.set('outbox:bot', [{ text: 'Still unsent' }]);
  const before = h.rows.get('outbox:bot');
  const restored = harness(h.rows);
  assert.equal(await restored.get('outbox:bot', 'unreadable'), 'unreadable');
  await restored.set('outbox:bot', []);
  assert.equal(h.rows.get('outbox:bot'), before);
  assert.equal(restored.secrets.size, 0);
  await restored.remove('');
  await restored.set('drafts', { text: 'Fresh cache' });
  assert.deepEqual(structuredClone(await restored.get('drafts', {})), { text: 'Fresh cache' });
});

test('restored cache reports the missing key and resets only on explicit request', async () => {
  const original = harness();
  await original.set('drafts', { text: 'old draft' });
  await original.set('outbox:bot', [{ text: 'old unsent message' }]);
  const oldKey = [...original.secrets.values()][0];
  const before = new Map(original.rows);
  const restored = harness(original.rows);
  const changes: string[] = [];
  const unsubscribe = restored.subscribe(() => changes.push(restored.status()));
  assert.equal(await restored.get('drafts', 'unavailable'), 'unavailable');
  assert.equal(restored.status(), 'unavailable');
  await restored.set('drafts', { text: 'new draft' });
  assert.deepEqual(restored.rows, before);
  assert.equal(restored.secrets.size, 0);
  await restored.reset();
  assert.equal(restored.status(), 'ready');
  assert.deepEqual(changes, ['unavailable', 'ready']);
  unsubscribe();
  assert.equal(restored.rows.size, 0);
  assert.notEqual([...restored.secrets.values()][0], oldKey);
  await restored.set('drafts', { text: 'new draft' });
  await restored.set('outbox:bot', [{ text: 'new message' }]);
  assert.deepEqual(structuredClone(await restored.get('drafts', null)), { text: 'new draft' });
  assert.deepEqual(structuredClone(await restored.get('outbox:bot', null)), [{ text: 'new message' }]);
});

test('healthy cache remains ready and retains existing data', async () => {
  const h = harness();
  await h.set('drafts', { text: 'kept' });
  const restarted = harness(h.rows, h.secrets);
  assert.deepEqual(structuredClone(await restarted.get('drafts', null)), { text: 'kept' });
  assert.equal(restarted.status(), 'ready');
});

test('queued migration and rapid draft saves cannot overwrite newer text or revive removed rows', async () => {
  const h = harness(new Map([['drafts', JSON.stringify({ text: 'Old' })]]));
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.writes(async () => { started(); await gate; });
  const reading = h.get('drafts', {});
  await writing;
  const saving = h.set('drafts', { text: 'Latest' });
  const removing = h.remove('draft');
  release();
  await Promise.all([reading, saving, removing]);
  assert.equal(h.rows.has('drafts'), false);
  await h.set('drafts', { text: 'After removal' });
  assert.deepEqual(structuredClone(await h.get('drafts', {})), { text: 'After removal' });
});

test('an interrupted legacy migration retries safely and does not block later writes', async () => {
  const h = harness(new Map([['drafts', '{"text":"Keep"}'], ['outbox:bot', '[{"text":"Keep too"}]']]));
  h.writes(async (key) => { if (key === 'outbox:bot') throw new Error('Disk full'); });
  assert.equal(await h.get('drafts', 'unavailable'), 'unavailable');
  const alreadySealed = h.rows.get('drafts');
  h.writes(async () => {});
  assert.deepEqual(structuredClone(await h.get('outbox:bot', [])), [{ text: 'Keep too' }]);
  assert.equal(h.rows.get('drafts'), alreadySealed);
});

test('durable replay writes reject on keychain or disk failure and preserve the preceding checkpoint', async () => {
  const h = harness();
  h.keychain(false); await assert.rejects(h.strict('replay:bot', { cursor: 1 }));
  assert.equal(h.rows.size, 0);
  h.keychain(true); await h.strict('replay:bot', { cursor: 1, messages: ['applied'] });
  const durable = h.rows.get('replay:bot');
  h.writes(async () => { throw new Error('Disk full'); });
  await assert.rejects(h.strict('replay:bot', { cursor: 2 }));
  assert.equal(h.rows.get('replay:bot'), durable);
  h.writes(async () => {});
  assert.deepEqual(structuredClone(await h.get('replay:bot', null)), { cursor: 1, messages: ['applied'] });
});


test('cache diagnostics require explicit opt-in and do no clock or logging work when disabled', async () => {
  for (const flag of [undefined, '0', 'yes']) {
    const h = harness(undefined, undefined, { flag });
    await h.set('msgs:private-server:private-chat', [{ text: 'secret' }]);
    await h.strict('replay:private-server', { cursor: 1 });
    assert.equal(h.clockReads(), 0);
    assert.deepEqual(h.logs, []);
  }
});

test('enabled native save reports numeric aggregate UTF-8 bytes, messages and synchronous versus awaited timing', async () => {
  const h = harness(undefined, undefined, { flag: '1' });
  h.writes(async () => { h.advance(11); });
  const value = [{ text: 'private 🔒', toJSON() { h.advance(2); return { text: this.text }; } }];
  await h.set('msgs:private-server:private-chat', value);
  assert.equal(h.logs.length, 1, 'first completion must be visible, even without ten saves');
  const [tag, d] = h.logs[0];
  assert.equal(tag, '[winglet-cache-perf]');
  assert.equal(d.category, 1);
  assert.equal(d.cold, 1);
  assert.equal(d.strict, 0);
  assert.equal(d.count, 1);
  assert.equal(d.errors, 0);
  assert.equal(d.messagesTotal, 1);
  assert.equal(d.bytesTotal, Buffer.byteLength('[{"text":"private 🔒"}]'));
  assert.equal(d.jsonMsTotal, 2);
  assert.equal(d.sqliteMsTotal, 11);
  assert.equal(d.totalMsTotal, 13);
  assert.equal(d.syncMsTotal, 2);
  assert.equal(d.totalMsMax, 13);
  assert.ok(Object.values(d).every((n) => typeof n === 'number'));
  assert.doesNotMatch(JSON.stringify(h.logs), /private|secret|winglet-cache:v1/);
});

test('diagnostic byte encoding has a separate nonzero stage and totals reconcile without derived syncMs', async () => {
  const h = harness(new Map([['drafts', '{"text":"legacy"}']]), undefined,
    { flag: '1', encodeMs: 4, readyMs: 7, sealMs: 3 });
  h.writes(async () => { h.advance(11); });
  const value = [{ toJSON() { h.advance(2); return '🔒'; } }];
  await h.set('msgs:private:chat', value);
  await h.set('msgs:private:chat', value);
  for (const [, d] of h.logs) {
    assert.equal(d.bytesMsTotal, 4, 'only the extra byte-count encode belongs to diagnostic overhead');
    assert.equal(d.jsonMsTotal, 2);
    assert.equal(d.sealMsTotal, 14, 'current save includes two UTF-8 and two base64 encodings');
    assert.equal(d.sqliteMsTotal, 11, 'current save write only');
    assert.equal(d.syncMsTotal, 16, 'excludes migration crypto and byte-count encoding');
    const measured = ['jsonMs', 'bytesMs', 'queueMs', 'readyMs', 'sealMs', 'sqliteMs']
      .reduce((sum, stage) => sum + d[`${stage}Total`], 0);
    assert.equal(d.totalMsTotal, measured, 'fake-clock stages account for all diagnostic-on elapsed time');
  }
  assert.equal(h.logs[0][1].readyMsTotal, 35, 'cold key setup plus migration seal and database write');
  assert.equal(h.logs[0][1].totalMsTotal, 66);
  assert.equal(h.logs[1][1].readyMsTotal, 0);
  assert.equal(h.logs[1][1].totalMsTotal, 31);
});

test('diagnostics separate queue wait, cold readiness and synchronous sealing; aggregates are bounded', async () => {
  const h = harness(undefined, undefined, { flag: '1', readyMs: 7, sealMs: 3 });
  await h.strict('msgs:server:chat', [1, 2]);
  const first = h.logs[0][1];
  assert.equal(first.readyMsTotal, 10, 'cold readiness includes keychain wait and encoding the new device key');
  assert.equal(first.sealMsTotal, 6, 'both base64 encodings are inside seal');
  assert.equal(first.syncMsTotal, 6);
  assert.equal(first.totalMsTotal, 16);
  let unblock!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  h.writes(async () => { entered(); await new Promise<void>((resolve) => { unblock = resolve; }); });
  const a = h.set('msgs:server:one', [1]);
  await waiting;
  const b = h.set('msgs:other:two', [1, 2, 3]);
  h.advance(17);
  h.writes(async () => {});
  unblock();
  await Promise.all([a, b]);
  assert.equal(h.logs[1][1].cold, 0);
  assert.equal(h.logs[1][1].sqliteMsTotal, 17);
  // Same logical bucket despite different ids. Output is cumulative, not one line per save.
  for (let i = 0; i < 8; i++) await h.set(`msgs:different:${i}`, [1]);
  const s = h.logs.at(-1)[1];
  assert.equal(h.logs.length, 3);
  assert.equal(s.count, 10);
  assert.equal(s.queueMsTotal, 17);
  assert.equal(s.queueMsMax, 17);
  assert.equal(s.messagesTotal, 12);
  assert.equal(s.readyMsTotal, 0);
  assert.equal(s.sealMsTotal, 60);
});

test('diagnostics preserve best-effort/strict failures and queue recovery without logging error content', async () => {
  const h = harness(undefined, undefined, { flag: '1' });
  h.keychain(false);
  await h.set('drafts', { text: 'secret' });
  await assert.rejects(h.strict('replay:private', {}), /Keychain unavailable/);
  assert.equal(h.logs[0][1].errors, 1);
  assert.equal(h.logs[1][1].errors, 1);
  h.keychain(true);
  await h.strict('replay:private', { cursor: 1 });
  const checkpoint = h.rows.get('replay:private');
  h.writes(async () => { h.advance(9); throw new Error('private disk detail'); });
  await assert.rejects(h.strict('replay:private', { cursor: 2 }), /private disk detail/);
  await h.set('msgs:private:private', ['secret']);
  assert.equal(h.rows.get('replay:private'), checkpoint);
  assert.equal(h.logs.at(-1)[1].sqliteMsTotal, 9);
  assert.doesNotMatch(JSON.stringify(h.logs), /private|secret|Keychain|cursor/);
  h.writes(async () => {});
  await h.set('msgs:private:private', ['recovered']);
  assert.deepEqual(structuredClone(await h.get('msgs:private:private', [])), ['recovered']);
});

test('serialization failure, unknown categories and non-message arrays have safe metadata', async () => {
  const h = harness(undefined, undefined, { flag: '1' });
  const circular: any = {}; circular.self = circular;
  await h.set('unknown-sensitive-key', circular);
  await assert.rejects(h.strict('another-sensitive-key', circular), /circular/i);
  await h.strict('outbox:private', [1, 2, 3]);
  assert.equal(h.logs[0][1].category, 0);
  assert.equal(h.logs[0][1].bytesTotal, 0);
  assert.equal(h.logs[0][1].errors, 1);
  assert.equal(h.logs[2][1].category, 4);
  assert.equal(h.logs[2][1].messagesTotal, 0);
  assert.ok(h.logs.every(([, s]) => Object.values(s).every((n) => typeof n === 'number')));
});

test('throwing diagnostic logger or clock cannot affect writes or rejection semantics', async () => {
  for (const option of [{ brokenLog: true }, { brokenClock: true }]) {
    const h = harness(undefined, undefined, { flag: '1', ...option });
    await h.set('msgs:private:chat', ['a']);
    await h.strict('replay:private', { cursor: 1 });
    assert.equal(h.rows.size, 2);
    h.writes(async () => { throw new Error('disk failure'); });
    await assert.rejects(h.strict('replay:private', {}), /disk failure/);
    await h.set('msgs:private:chat', ['b']);
    assert.deepEqual(structuredClone(await h.get('msgs:private:chat', [])), ['a']);
  }
});

test('missing, throwing and nonfinite diagnostic clocks suppress samples without changing storage semantics', async () => {
  for (const option of [
    { missingClock: 'performance' as const }, { missingClock: 'now' as const }, { brokenClock: true },
    ...[NaN, Infinity, -Infinity].map((value) => ({ clock: () => value })),
  ]) {
    const h = harness(undefined, undefined, { flag: '1', ...option });
    await h.set('msgs:private:chat', ['kept']);
    await h.strict('replay:private', { cursor: 1 });
    const checkpoint = h.rows.get('replay:private');
    h.writes(async () => { throw new Error('disk failure'); });
    await h.set('msgs:private:chat', ['not saved']);
    await assert.rejects(h.strict('replay:private', { cursor: 2 }), /disk failure/);
    assert.equal(h.rows.get('replay:private'), checkpoint);
    h.writes(async () => {});
    await h.strict('replay:private', { cursor: 3 });
    assert.deepEqual(structuredClone(await h.get('msgs:private:chat', [])), ['kept']);
    assert.deepEqual(structuredClone(await h.get('replay:private', null)), { cursor: 3 });
    assert.deepEqual(h.logs, [], 'invalid clocks must not emit plausible zero-time samples');
  }
});

test('a clock failure after starting suppresses the whole sample without poisoning later aggregates', async () => {
  for (const failAt of [4, 8]) {
    for (const failure of ['throw', NaN, Infinity, -Infinity]) {
      const h = harness(undefined, undefined, { flag: '1', clock: (read, now) => {
        if (read !== failAt) return now;
        if (failure === 'throw') throw new Error('clock');
        return failure as number;
      } });
      await h.strict('replay:private', { cursor: 1 });
      assert.deepEqual(h.logs, [], 'invalid mid-save or final reading discards the entire sample');
      await h.strict('replay:private', { cursor: 2 });
      assert.equal(h.logs.length, 1);
      assert.equal(h.logs[0][1].count, 1);
      assert.equal(h.logs[0][1].totalMsTotal, 0);
      assert.equal(h.logs[0][1].totalBin0, 1);
    }
  }
});

test('a valid constant clock retains legitimate zero-duration saves', async () => {
  const h = harness(undefined, undefined, { flag: '1' });
  await h.strict('replay:private', { cursor: 1 });
  assert.equal(h.logs.length, 1);
  const d = h.logs[0][1];
  assert.equal(d.count, 1);
  assert.equal(d.totalBin0, 1);
  for (const stage of ['jsonMs', 'bytesMs', 'queueMs', 'readyMs', 'sealMs', 'sqliteMs', 'syncMs', 'totalMs']) {
    assert.equal(d[`${stage}Total`], 0);
    assert.equal(d[`${stage}Max`], 0);
  }
});
