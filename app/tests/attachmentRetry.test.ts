import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

function deferred() {
  let resolve!: (value?: any) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const upload = { id: 'uploaded', name: 'photo.jpg', kind: 'image', mime: 'image/jpeg', size: 12 };

function harness(os = 'android') {
  const preparations: any[] = [];
  const uploads: any[] = [];
  const fetches: any[] = [];
  const sent: any[] = [];
  const sending = deferred();
  let holdSend = false;
  const haptics = { light: 0, error: 0 };
  let writes = 0;
  const state = {
    servers: [{ id: 's' }, { id: 'other' }], draftFiles: {} as Record<string, any[]>,
    updateDraftFiles(s: string, c: string, fn: (files: any[]) => any[]) {
      writes++;
      state.draftFiles[`${s}:${c}`] = fn(state.draftFiles[`${s}:${c}`] ?? []);
    },
    async sendMessage(...args: any[]) { sent.push(args); if (holdSend) await sending.promise; },
  };
  const exports: any = {};
  // Execute the complete real module. Only import/export wiring is replaced;
  // Node's native type stripper leaves all production function bodies intact.
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/lib/attach.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(source + '\nObject.assign(exports, { attachFiles, retryFile, removeFile });', {
    exports, Platform: { OS: os }, useApp: { getState: () => state },
    haptic: { light: () => haptics.light++, error: () => haptics.error++ },
    preparePhoto(file: any) {
      const d = deferred(); preparations.push({ ...d, file }); return d.promise;
    },
    uploadFile(server: any, chat: string, file: any, progress: (p: number) => void, kind: any) {
      const d = deferred();
      const entry = { ...d, server, chat, file, progress, kind, aborts: 0 };
      uploads.push(entry);
      // Deliberately do not settle on abort: exercise transports with late callbacks.
      return { promise: d.promise, abort: () => entry.aborts++ };
    },
    fetch() {
      const response = deferred(), blob = deferred();
      fetches.push({ response, blob });
      return response.promise;
    },
  }, { filename: 'attach.ts' });
  const files = (s = 's', c = 'chat') => state.draftFiles[`${s}:${c}`] ?? [];
  function attach(s = 's', c = 'chat', voice = false) {
    exports.attachFiles(s, c, [{ uri: 'local:photo', name: 'photo.jpg', mime: 'image/jpeg', isImage: true }], { voice });
    return files(s, c).at(-1).localId as string;
  }
  return { ...exports, attach, files, preparations, uploads, fetches, sent, haptics, writes: () => writes,
    holdSend: () => { holdSend = true; }, sending,
    async close() {
      sending.resolve();
      // Bounded teardown also drains duplicate starts on the unfixed module.
      for (const [key, list] of Object.entries(state.draftFiles)) {
        const [s, c] = key.split(':');
        for (const f of list) exports.removeFile(s, c, f.localId);
      }
      for (let i = 0; i < 8; i++) {
        preparations.forEach((p) => p.resolve(p.file));
        fetches.forEach((f) => { f.response.resolve({ blob: () => f.blob.promise }); f.blob.resolve({}); });
        uploads.forEach((u) => u.resolve(upload));
        await tick();
      }
    },
  };
}

test('repeated Retry during preparation starts only one preparation and upload', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    const id = h.attach();
    h.retryFile('s', 'chat', id);
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 1, 'one preparation owns the file before any await');
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    assert.equal(h.uploads.length, 1);
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.files()[0].status, 'ready');
    assert.equal(h.haptics.error, 0);
  } finally { await h.close(); }
});

test('repeated Retry during upload keeps the single handle and current progress', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    const id = h.attach();
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    h.retryFile('s', 'chat', id);
    h.retryFile('s', 'chat', id);
    await tick();
    assert.equal(h.preparations.length, 1);
    assert.equal(h.uploads.length, 1);
    h.uploads[0].progress(0.4);
    assert.equal(h.files()[0].progress, 0.4);
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.files()[0].status, 'ready');
    const writes = h.writes();
    h.uploads[0].progress(0.9);
    await tick();
    assert.equal(h.writes(), writes, 'settled callbacks cannot mutate the completed draft');
    assert.equal(h.files()[0].progress, 1);
  } finally { await h.close(); }
});

for (const phase of ['preparation', 'upload']) {
  test(`legitimate retry after ${phase} failure; old progress cannot mutate its successor`, { timeout: 2000 }, async () => {
    const h = harness();
    try {
      const id = h.attach();
      if (phase === 'preparation') h.preparations[0].reject(new Error('preparation failed'));
      else {
        h.preparations[0].resolve(h.preparations[0].file);
        await tick();
        h.uploads[0].reject(new Error('upload failed'));
      }
      await tick();
      assert.equal(h.files()[0].status, 'failed');
      assert.equal(h.haptics.error, 1);
      h.retryFile('s', 'chat', id);
      h.retryFile('s', 'chat', id);
      assert.equal(h.preparations.length, 2);
      assert.equal(h.files()[0].status, 'uploading');
      assert.equal(h.files()[0].error, undefined);
      const writes = h.writes();
      h.uploads[0]?.progress(0.99);
      assert.equal(h.writes(), writes, 'old progress ignored while successor prepares');
      h.preparations[1].resolve(h.preparations[1].file);
      await tick();
      const current = h.uploads.at(-1);
      if (phase === 'upload') {
        h.uploads[0].progress(0.99);
        assert.equal(h.files()[0].progress, 0);
        h.retryFile('s', 'chat', id);
        assert.equal(h.preparations.length, 2, 'old cleanup has not released successor ownership');
      }
      current.progress(0.5);
      assert.equal(h.files()[0].progress, 0.5);
      current.resolve(upload);
      await tick();
      assert.equal(h.files()[0].status, 'ready');
      assert.equal(h.haptics.error, 1);
    } finally { await h.close(); }
  });
}

test('distinct files and server/chat composers prepare and upload independently', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    const targets = [['s', 'chat'], ['s', 'chat'], ['s', 'second'], ['other', 'chat']];
    const ids = targets.map(([s, c]) => h.attach(s, c));
    assert.equal(new Set(ids).size, 4);
    assert.equal(h.preparations.length, 4);
    targets.forEach(([s, c], i) => h.retryFile(s, c, ids[i]));
    assert.equal(h.preparations.length, 4);
    h.preparations.forEach((p: any) => p.resolve(p.file));
    await tick();
    assert.equal(h.uploads.length, 4);
    assert.deepEqual(h.uploads.map((u: any) => `${u.server.id}:${u.chat}`), targets.map(([s, c]) => `${s}:${c}`));
    h.uploads[0].reject(new Error('first failed'));
    h.uploads.slice(1).forEach((u: any) => u.resolve(upload));
    await tick();
    assert.equal(h.files()[0].status, 'failed');
    assert.equal(h.files()[1].status, 'ready');
    assert.equal(h.files('s', 'second')[0].status, 'ready');
    assert.equal(h.files('other', 'chat')[0].status, 'ready');
  } finally { await h.close(); }
});

for (const phase of ['preparation', 'upload']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`remove during ${phase}: ignore late ${outcome}, progress and Retry`, { timeout: 2000 }, async () => {
      const h = harness();
      try {
        const id = h.attach('s', 'chat', true);
        if (phase === 'upload') {
          h.preparations[0].resolve(h.preparations[0].file);
          await tick();
        }
        h.removeFile('s', 'chat', id);
        assert.equal(h.files().length, 0);
        if (phase === 'upload') assert.equal(h.uploads[0].aborts, 1);
        h.retryFile('s', 'chat', id);
        const writes = h.writes();
        const pending = phase === 'preparation' ? h.preparations[0] : h.uploads[0];
        if (outcome === 'reject') pending.reject(new Error('late failure'));
        else pending.resolve(phase === 'preparation' ? pending.file : upload);
        h.uploads[0]?.progress(0.9);
        await tick();
        assert.equal(h.writes(), writes, 'no mutation even when the removed tray item is absent');
        assert.equal(h.files().length, 0);
        assert.equal(h.preparations.length, 1);
        assert.equal(h.uploads.length, phase === 'upload' ? 1 : 0);
        assert.equal(h.sent.length, 0, 'removed voice note must not auto-send');
        assert.equal(h.haptics.error, 0);
        // A different file may start before the cancelled transport settles.
        const next = h.attach();
        h.retryFile('s', 'chat', next);
        assert.equal(h.preparations.length, 2);
      } finally { await h.close(); }
    });
  }
}

test('cancelled upload cleanup cannot release or mutate an independent active file', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    const old = h.attach();
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    h.removeFile('s', 'chat', old);
    const next = h.attach();
    h.preparations[1].resolve(h.preparations[1].file);
    await tick();
    const writes = h.writes();
    h.uploads[0].progress(0.99);
    h.uploads[0].reject(new Error('late failure'));
    await tick();
    assert.equal(h.writes(), writes);
    h.retryFile('s', 'chat', next);
    assert.equal(h.preparations.length, 2);
    h.uploads[1].progress(0.6);
    assert.equal(h.files()[0].progress, 0.6);
    h.removeFile('s', 'chat', next);
    assert.equal(h.uploads[1].aborts, 1, 'successor handle still exists');
    assert.equal(h.haptics.error, 0);
  } finally { await h.close(); }
});

test('web response and blob conversion retain ownership before an upload handle exists', { timeout: 2000 }, async () => {
  const h = harness('web');
  try {
    const id = h.attach();
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    assert.equal(h.fetches.length, 1);
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 1);
    assert.equal(h.uploads.length, 0);
    h.fetches[0].response.resolve({ blob: () => h.fetches[0].blob.promise });
    await tick();
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 1);
    assert.equal(h.uploads.length, 0);
    const blob = {};
    h.fetches[0].blob.resolve(blob);
    await tick();
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].file.file, blob);
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 1);
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.files()[0].status, 'ready');
  } finally { await h.close(); }
});

for (const phase of ['response', 'blob']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`web remove during ${phase}: late ${outcome} cannot upload, patch or send`, { timeout: 2000 }, async () => {
      const h = harness('web');
      try {
        const id = h.attach('s', 'chat', true);
        h.preparations[0].resolve(h.preparations[0].file);
        await tick();
        const f = h.fetches[0];
        if (phase === 'blob') {
          f.response.resolve({ blob: () => f.blob.promise });
          await tick();
        }
        h.removeFile('s', 'chat', id);
        const writes = h.writes();
        h.retryFile('s', 'chat', id);
        if (phase === 'response') {
          if (outcome === 'reject') f.response.reject(new Error('late fetch failure'));
          else { f.response.resolve({ blob: () => f.blob.promise }); f.blob.resolve({}); }
        } else if (outcome === 'reject') f.blob.reject(new Error('late blob failure'));
        else f.blob.resolve({});
        await tick();
        assert.equal(h.uploads.length, 0);
        assert.equal(h.preparations.length, 1);
        assert.equal(h.writes(), writes);
        assert.equal(h.sent.length, 0);
        assert.equal(h.haptics.error, 0);
      } finally { await h.close(); }
    });
  }
}

test('web conversion failure releases ownership for a legitimate retry', { timeout: 2000 }, async () => {
  const h = harness('web');
  try {
    const id = h.attach();
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    h.fetches[0].response.resolve({ blob: () => h.fetches[0].blob.promise });
    h.fetches[0].blob.reject(new Error('blob failure'));
    await tick();
    assert.equal(h.files()[0].status, 'failed');
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 2);
    h.preparations[1].resolve(h.preparations[1].file);
    await tick();
    h.fetches[1].response.resolve({ blob: () => h.fetches[1].blob.promise });
    h.fetches[1].blob.resolve({});
    await tick();
    assert.equal(h.uploads.length, 1);
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.files()[0].status, 'ready');
    assert.equal(h.haptics.error, 1);
  } finally { await h.close(); }
});

test('voice auto-send remains once-only after upload with repeated Retry and late callbacks', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    const id = h.attach('s', 'chat', true);
    h.retryFile('s', 'chat', id);
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    assert.equal(h.uploads[0].kind, 'voice');
    h.retryFile('s', 'chat', id);
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.preparations.length, 1);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0][0], 's');
    assert.equal(h.sent[0][1], 'chat');
    assert.equal(h.sent[0][2], '');
    assert.equal(h.sent[0][3].attachments[0], upload);
    assert.equal(h.files().length, 0);
    const writes = h.writes();
    h.uploads[0].progress(0.1);
    h.retryFile('s', 'chat', id);
    await tick();
    assert.equal(h.writes(), writes);
    assert.equal(h.sent.length, 1);
    assert.equal(h.haptics.error, 0);
  } finally { await h.close(); }
});

test('late upload progress is ignored while voice auto-send awaits delivery', { timeout: 2000 }, async () => {
  const h = harness();
  try {
    h.holdSend();
    const id = h.attach('s', 'chat', true);
    h.preparations[0].resolve(h.preparations[0].file);
    await tick();
    h.uploads[0].resolve(upload);
    await tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.files().length, 0);
    const writes = h.writes();
    h.uploads[0].progress(0.5);
    assert.equal(h.writes(), writes, 'settled upload cannot patch while voice delivery is pending');
    h.retryFile('s', 'chat', id);
    assert.equal(h.preparations.length, 1);
    h.sending.resolve();
    await tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.haptics.error, 0);
  } finally { await h.close(); }
});
