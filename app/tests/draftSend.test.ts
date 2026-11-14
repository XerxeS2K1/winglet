import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

// Real attachment, store, command and message logic; only device, transport and
// storage boundaries are replaced, following store.test.ts's VM harness.
function harness() {
  let request: (...args: any[]) => Promise<any> = async () => { throw new ApiError('offline', 0); };
  const cache = new Map<string, any>();
  const load = (file: string, modules: Record<string, any> = {}): any => {
    const exports: any = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
    return exports;
  };
  const protocol = load('features/event-replay/protocol');
  const { useApp: store } = load('lib/store', {
    zustand: { create: (fn: any) => createStore(fn) },
    'zustand/react/shallow': { useShallow: (fn: any) => fn },
    'react-native': { Platform: { OS: 'android' } },
    './recovery': { RecoveryCoordinator: class {} },
    '../features/phone-tools/runtime': {},
    './sounds': { sound: {} },
    './api': { ApiError, api: (...args: any[]) => request(...args), signedApi: (...args: any[]) => request(...args) },
    './commands': load('lib/commands', { './api': {} }),
    './cache': { cacheSet: async (key: string, value: any) => cache.set(key, structuredClone(value)) },
    '../features/event-replay/merge': load('features/event-replay/merge'),
    '../features/event-replay/session': load('features/event-replay/session', { './protocol': protocol }),
    './messages': load('lib/messages'),
    './streamBuffer': load('lib/streamBuffer'),
    './perf': { PERF_ON: false }, './storage': {}, './verify': {}, './network': {}, './authCheck': {},
    '../features/encrypted-push/native': {}, './handledNotifications': load('lib/handledNotifications'),
    '../features/execution/model': load('features/execution/model'),
    '../features/projects/logic': load('features/projects/logic'),
  });
  store.setState({ servers: [{ id: 's' }, { id: 'other' }], network: true,
    runtime: { s: { status: 'online', outbox: [], messages: {}, deleted: {} } } });
  let preparations = 0;
  const attach = load('lib/attach', {
    'react-native': { Platform: { OS: 'android' } }, './store': { useApp: store },
    './haptics': { haptic: { light() {}, error() {} } },
    './media': { preparePhoto: async (file: any) => { preparations++; return file; },
      uploadFile: () => ({ promise: Promise.resolve({ id: 'upload', name: 'photo.png', mime: 'image/png', kind: 'image', size: 3 }), abort() {} }) },
  });
  const key = 's:chat';
  const text = '/approvals off';
  const reply = { id: 'quoted', role: 'bot', text: 'Original quote' };
  store.getState().setDraft('s', 'chat', text);
  store.getState().setReplyTo('s', 'chat', reply);
  const ready = { localId: 'ready', status: 'ready', upload: { id: 'upload' } };
  const uploading = { localId: 'uploading', status: 'uploading' };
  const failed = { localId: 'failed', status: 'failed' };
  store.getState().updateDraftFiles('s', 'chat', () => [ready, uploading, failed]);
  return { ...attach, store, cache, key, text, reply, ready, uploading, failed,
    state: () => store.getState(), request: (fn: typeof request) => { request = fn; },
    preparations: () => preparations };
}

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const accepted = { message: { id: 'accepted', chat_id: 'chat', role: 'user', text: 'sent',
  status: 'final', meta: {}, created_at: 1, updated_at: 1 } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('success clears only submitted content, preserves failed/uploading files and allows a later send', async () => {
  const h = harness();
  let calls = 0;
  h.request(async () => { calls++; return accepted; });
  await h.sendDraft('s', 'chat', h.text);
  assert.equal(h.state().toasts.length, 0);
  assert.equal(h.state().drafts[h.key], undefined);
  assert.equal(h.state().replyTo[h.key], undefined);
  assert.deepEqual(structuredClone(h.state().draftFiles[h.key]), [h.uploading, h.failed]);
  h.state().setDraft('s', 'chat', h.text);
  await h.sendDraft('s', 'chat', h.text);
  assert.equal(calls, 2, 'an intentional later repeat remains allowed');
});

test('ordinary offline sends clear the draft only after entering the real outbox', async () => {
  const h = harness();
  h.store.setState({ runtime: { s: { status: 'offline', outbox: [], messages: {}, deleted: {} } } });
  h.state().setDraft('s', 'chat', 'Offline question');
  await h.sendDraft('s', 'chat', 'Offline question');
  assert.equal(h.state().drafts[h.key], undefined);
  const queued = h.cache.get('outbox:s');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, 'Offline question');
  assert.equal(queued[0].attachments[0].id, 'upload');
  assert.equal(queued[0].reply_to.id, h.reply.id);
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`delayed ${outcome} preserves newer text/reply/files and never restores a removed file`, async () => {
    const h = harness();
    const wait = deferred();
    h.request(() => wait.promise);
    const sending = h.sendDraft('s', 'chat', h.text);
    h.state().setDraft('s', 'chat', 'New text');
    const reply = { id: 'new', text: 'New reply' };
    h.state().setReplyTo('s', 'chat', reply);
    h.removeFile('s', 'chat', h.ready.localId);
    const added = { localId: 'new-file', status: 'ready', upload: { id: 'new-upload' } };
    h.state().updateDraftFiles('s', 'chat', (files: any[]) => [...files, added]);
    if (outcome === 'resolve') wait.resolve(accepted); else wait.reject(new ApiError('Signing refused', 403));
    await sending.catch(() => {});
    assert.equal(h.state().toasts.length, outcome === 'resolve' ? 0 : 1);
    assert.equal(h.state().drafts[h.key], 'New text');
    assert.equal(h.state().replyTo[h.key], reply);
    assert.deepEqual(structuredClone(h.state().draftFiles[h.key]), [h.uploading, h.failed, added]);
  });
}

test('editing away and back while sending still counts as a new text draft', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  h.state().setDraft('s', 'chat', 'temporary edit');
  h.state().setDraft('s', 'chat', h.text);
  wait.resolve(accepted); await sending;
  assert.equal(h.state().drafts[h.key], h.text);
});

test('pending sends cannot be submitted twice; failure releases the guard for retry', async () => {
  const h = harness(); const wait = deferred(); let calls = 0;
  h.request(() => { calls++; return wait.promise; });
  const sending = h.sendDraft('s', 'chat', h.text);
  const duplicate = h.sendDraft('s', 'chat', h.text);
  try {
    await tick();
    assert.equal(calls, 1);
  } finally {
    wait.reject(new ApiError('Signing refused', 403));
    await Promise.allSettled([sending, duplicate]);
  }
  h.request(async () => { calls++; return accepted; });
  await h.sendDraft('s', 'chat', h.state().drafts[h.key]);
  assert.equal(calls, 2);
});

test('empty sends do nothing, including leaving reply and failed/uploading files alone', async () => {
  const h = harness(); let calls = 0; h.request(async () => { calls++; return accepted; });
  h.removeFile('s', 'chat', h.ready.localId);
  await h.sendDraft('s', 'chat', '   ');
  assert.equal(calls, 0);
  assert.equal(h.state().replyTo[h.key], h.reply);
  assert.deepEqual(structuredClone(h.state().draftFiles[h.key]), [h.uploading, h.failed]);
});

test('a pending send neither locks another chat/server nor clears a replacement server draft', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  // Transport controls for the independent composer sends; the real first send remains pending.
  const sent: any[] = [];
  h.store.setState({ sendMessage: async (...args: any[]) => { sent.push(args); } });
  h.state().setDraft('s', 'elsewhere', 'Other chat');
  h.state().setDraft('other', 'chat', 'Other server');
  await h.sendDraft('s', 'elsewhere', 'Other chat');
  await h.sendDraft('other', 'chat', 'Other server');
  assert.deepEqual(sent.map(args => args.slice(0, 3)), [['s', 'elsewhere', 'Other chat'], ['other', 'chat', 'Other server']]);
  h.store.setState({ servers: [{ id: 's', token: 'replacement-fixture' }] });
  wait.resolve(accepted); await sending;
  assert.equal(h.state().drafts[h.key], h.text);
  assert.equal(h.state().replyTo[h.key], h.reply);
  assert.equal(h.state().draftFiles[h.key][0], h.ready);
});

test('failed send retains original picks for retrying the attachment upload', async () => {
  const h = harness();
  h.state().updateDraftFiles('s', 'chat', () => []);
  h.attachFiles('s', 'chat', [{ uri: 'file:///photo.png', name: 'photo.png', mime: 'image/png', size: 3 }]);
  await tick();
  const file = h.state().draftFiles[h.key][0];
  assert.equal(file.status, 'ready');
  await h.sendDraft('s', 'chat', h.text).catch(() => {});
  h.retryFile('s', 'chat', file.localId); await tick();
  assert.equal(h.preparations(), 2);
  assert.equal(h.state().draftFiles[h.key][0].status, 'ready');
});

test('accepted send removes submitted files but keeps newly ready/newly added files and newer text', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  assert.equal(h.state().drafts[h.key], h.text, 'draft stays visible while awaiting acceptance');
  h.state().setDraft('s', 'chat', 'Next question');
  const added = { localId: 'new-file', status: 'ready', upload: { id: 'new-upload' } };
  const finished = { ...h.uploading, status: 'ready', upload: { id: 'finished-upload' } };
  h.state().updateDraftFiles('s', 'chat', (files: any[]) => [...files.map(f => f === h.uploading ? finished : f), added]);
  wait.resolve(accepted); await sending;
  assert.equal(h.state().toasts.length, 0);
  assert.equal(h.state().drafts[h.key], 'Next question');
  assert.deepEqual(structuredClone(h.state().draftFiles[h.key]), [finished, h.failed, added]);
});

test('ordinary network rejection remains queued, not a failed prequeue send', async () => {
  const h = harness();
  h.state().setDraft('s', 'chat', 'Question');
  await h.sendDraft('s', 'chat', 'Question');
  assert.equal(h.state().toasts.length, 0);
  assert.equal(h.state().drafts[h.key], undefined);
  assert.equal(h.state().runtime.s.outbox.length, 1);
  assert.equal(h.state().runtime.s.messages.chat[0].status, 'queued');
  assert.equal(h.cache.get('outbox:s')[0].text, 'Question');
});

test('attachment-only sends and prefixed text keep existing payload behaviour', async () => {
  const h = harness(); const sent: any[] = [];
  h.store.setState({ sendMessage: async (...args: any[]) => { sent.push(args); } });
  h.state().setDraft('s', 'chat', '');
  await h.sendDraft('s', 'chat', '');
  assert.equal(sent[0][2], '');
  assert.equal(sent[0][3].attachments[0].id, 'upload');
  assert.equal(sent[0][3].replyTo, h.reply);
  h.state().setDraft('s', 'chat', '  Next question  ');
  await h.sendDraft('s', 'chat', '  Next question  ', '/queue');
  assert.equal(sent[1][2], '/queue Next question');
  assert.equal(h.state().drafts[h.key], undefined);
});

test('a real signed-send rejection before outbox admission preserves text, reply and ready files', async () => {
  const h = harness();
  h.request(async () => { throw new ApiError('Signing refused', 403); });
  // Accept either rejection propagation or an in-app error report; neither may lose the draft.
  await h.sendDraft('s', 'chat', h.text).catch(() => {});
  assert.equal(h.state().runtime.s.outbox.length, 0);
  assert.equal(h.cache.has('outbox:s'), false);
  assert.deepEqual(structuredClone({ text: h.state().drafts[h.key], reply: h.state().replyTo[h.key], files: h.state().draftFiles[h.key] }),
    { text: h.text, reply: h.reply, files: [h.ready, h.uploading, h.failed] });
});

test('routine server metadata update must still clear a delivered draft', async () => {
  const h = harness(); const wait = deferred(); let calls = 0;
  h.request(() => { calls++; return wait.promise; });
  const sending = h.sendDraft('s', 'chat', h.text);
  h.store.setState({ servers: h.state().servers.map((s: any) => s.id === 's' ? {...s, wsAuth: true} : s) });
  wait.resolve(accepted); await sending;
  assert.equal(h.state().runtime.s.messages.chat.length, 1, 'the real store already recorded delivery');
  assert.equal(calls, 1);
  assert.equal(h.state().drafts[h.key], undefined, 'delivered content must not look unsent after metadata-only replacement');
});

test('ordinary second message enters outbox before predecessor delivery settles without reused files or reply', async () => {
  const h = harness(); const wait = deferred(); let calls = 0;
  h.request(() => { calls++; return wait.promise; });
  h.state().setDraft('s', 'chat', 'First question');
  const first = h.sendDraft('s', 'chat', 'First question');
  let second: Promise<any> | undefined;
  try {
    await tick();
    assert.equal(h.state().drafts[h.key], undefined, 'outbox admission consumes the first draft');
    h.state().setDraft('s', 'chat', 'Second question');
    second = h.sendDraft('s', 'chat', 'Second question');
    await tick();
    const entries = h.state().runtime.s.outbox;
    assert.equal(entries.length, 2);
    assert.equal(entries[1].text, 'Second question');
    assert.equal(entries[1].attachments, undefined);
    assert.equal(entries[1].reply_to, undefined);
    assert.equal(calls, 1, 'existing delivery chain remains serial');
    assert.equal(h.state().drafts[h.key], undefined);
  } finally {
    wait.resolve(accepted); await Promise.allSettled([first, second]);
  }
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`harmless metadata refresh preserves failure feedback or clears success: ${outcome}`, async () => {
    const h = harness(); const wait = deferred(); h.request(() => wait.promise);
    const sending = h.sendDraft('s', 'chat', h.text);
    h.store.setState({ servers: h.state().servers.map((s: any) => ({ ...s, wsAuth: true, bot: { title: 'Updated title' } })) });
    if (outcome === 'resolve') wait.resolve(accepted); else wait.reject(new ApiError('Signing refused', 403));
    assert.equal(await sending, outcome === 'resolve');
    assert.equal(h.state().toasts.length, outcome === 'reject' ? 1 : 0);
    assert.equal(h.state().drafts[h.key], outcome === 'reject' ? h.text : undefined);
    assert.equal(h.state().replyTo[h.key], outcome === 'reject' ? h.reply : undefined);
    assert.equal(h.state().draftFiles[h.key].includes(h.ready), outcome === 'reject');
  });
}
for (const change of ['url', 'token', 'deviceId', 'profile', 'parent', 'addedAt', 'remove', 'remove-readd']) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`connection ${change} is latched and isolated on ${outcome}`, async () => {
      const h = harness(); const wait = deferred(); h.request(() => wait.promise);
      const sending = h.sendDraft('s', 'chat', h.text);
      const servers = h.state().servers;
      h.store.setState({ servers: change.startsWith('remove') ? [] : servers.map((s: any) => s.id === 's' ? { ...s, [change]: change === 'addedAt' ? 2 : 'new-fixture' } : s) });
      if (change === 'remove-readd') h.store.setState({ servers });
      if (outcome === 'resolve') wait.resolve(accepted); else wait.reject(new ApiError('Signing refused', 403));
      assert.equal(await sending, false);
      assert.equal(h.state().drafts[h.key], h.text);
      assert.equal(h.state().replyTo[h.key], h.reply);
      assert.equal(h.state().draftFiles[h.key][0], h.ready);
      assert.equal(h.state().toasts.length, 0, 'do not target a removed or different connection');
    });
  }
}
for (const thrown of ['private-credential-fixture', undefined, { detail: 'private-credential-fixture' }]) {
  test(`non-Error rejection has safe useful feedback: ${typeof thrown}`, async () => {
    const h = harness(); h.request(async () => { throw thrown; });
    assert.equal(await h.sendDraft('s', 'chat', h.text), false);
    assert.equal(h.state().drafts[h.key], h.text);
    assert.equal(h.state().toasts.length, 1);
    assert.match(h.state().toasts[0].body, /draft.*try again/i);
    assert.ok(!h.state().toasts[0].body.includes('private-credential-fixture'));
  });
}
test('harmless ready attachment object refresh is consumed after success', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  h.state().updateDraftFiles('s', 'chat', (files: any[]) => files.map(f => ({ ...f, upload: f.upload ? { ...f.upload } : undefined })));
  wait.resolve(accepted); await sending;
  assert.deepEqual(h.state().draftFiles[h.key].map((f: any) => f.localId), ['uploading', 'failed']);
});
test('logically replaced upload keeps its original pick for another retry after old send succeeds', async () => {
  const h = harness(); h.state().updateDraftFiles('s', 'chat', () => []);
  h.attachFiles('s', 'chat', [{ uri: 'file:///photo.png', name: 'photo.png', mime: 'image/png', size: 3 }]);
  await tick(); const file = h.state().draftFiles[h.key][0];
  const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  h.retryFile('s', 'chat', file.localId); await tick();
  h.state().updateDraftFiles('s', 'chat', (files: any[]) => files.map(f => ({ ...f, upload: { ...f.upload, id: 'replacement-upload' } })));
  wait.resolve(accepted); await sending;
  assert.ok(h.state().draftFiles[h.key]?.[0], 'replacement upload must remain in the tray');
  assert.equal(h.state().draftFiles[h.key][0].upload.id, 'replacement-upload');
  h.retryFile('s', 'chat', file.localId); await tick();
  assert.equal(h.preparations(), 3, 'old admission must not delete the replacement upload original');
});
test('post-admission refusal keeps content in failed outbox and message, not composer', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  h.state().setDraft('s', 'chat', 'Refused question');
  const sending = h.sendDraft('s', 'chat', 'Refused question');
  let admitted = false;
  void sending.then((result: boolean) => { admitted = result; });
  try {
    await tick();
    assert.equal(admitted, true, 'submission settles at admission before transport');
  } finally {
    wait.reject(new ApiError('Conflict', 409)); await sending; await tick();
  }
  const entry = h.state().runtime.s.outbox[0];
  assert.equal(entry.failed, true);
  assert.equal(entry.text, 'Refused question');
  assert.equal(entry.attachments[0].id, 'upload');
  assert.equal(entry.reply_to.id, h.reply.id);
  assert.equal(h.state().runtime.s.messages.chat[0].status, 'failed');
  assert.equal(h.state().runtime.s.messages.chat[0].text, 'Refused question');
  assert.equal(h.state().drafts[h.key], undefined);
  assert.equal(h.state().replyTo[h.key], undefined);
  assert.deepEqual(structuredClone(h.state().draftFiles[h.key]), [h.uploading, h.failed]);
});

test('signed pending second submission reports blocked and preserves the newer draft', async () => {
  const h = harness(); const wait = deferred(); let calls = 0;
  h.request(() => { calls++; return wait.promise; });
  const first = h.sendDraft('s', 'chat', h.text);
  try {
    h.state().setDraft('s', 'chat', 'New question');
    const second = h.sendDraft('s', 'chat', 'New question');
    let result: boolean | undefined;
    void second.then((value: boolean) => { result = value; });
    await tick();
    assert.equal(result, false);
    assert.equal(calls, 1);
    assert.equal(h.state().drafts[h.key], 'New question');
  } finally { wait.resolve(accepted); await first; }
  assert.equal(h.state().drafts[h.key], 'New question');
});
test('synchronous ordinary double tap submits only once before admission is consumed', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  h.state().setDraft('s', 'chat', 'One question');
  const first = h.sendDraft('s', 'chat', 'One question');
  const second = h.sendDraft('s', 'chat', 'One question');
  let duplicateResult: boolean | undefined;
  void second.then((value: boolean) => { duplicateResult = value; });
  try {
    assert.equal(h.state().runtime.s.outbox.length, 1);
    await tick();
    assert.equal(duplicateResult, false);
  } finally { wait.resolve(accepted); await Promise.allSettled([first, second]); }
});

test('a replacement upload still in progress is not consumed even with its previous upload id', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  h.state().updateDraftFiles('s', 'chat', (files: any[]) => files.map(f => f.localId === h.ready.localId ? { ...f, status: 'uploading' } : f));
  wait.resolve(accepted); await sending;
  assert.equal(h.state().draftFiles[h.key][0].localId, h.ready.localId);
  assert.equal(h.state().draftFiles[h.key][0].status, 'uploading');
});
test('reply edited away and back remains the newer reply on acceptance', async () => {
  const h = harness(); const wait = deferred(); h.request(() => wait.promise);
  const sending = h.sendDraft('s', 'chat', h.text);
  h.state().setReplyTo('s', 'chat', undefined);
  h.state().setReplyTo('s', 'chat', h.reply);
  wait.resolve(accepted); await sending;
  assert.equal(h.state().replyTo[h.key], h.reply);
});
