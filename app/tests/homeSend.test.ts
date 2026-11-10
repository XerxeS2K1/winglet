import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

type Sent = { bot: string; chat: string; text: string; opts?: any };

function harness() {
  const state: any = {
    network: true,
    runtime: { main: { status: 'online' } },
    drafts: { 'main:local:new-chat': 'Hello there', 'main:general': 'Home draft' },
    draftFiles: { 'main:local:new-chat': [{ localId: 'f1', name: 'photo.png', status: 'ready', upload: { id: 'u1' } }] },
    replyTo: { 'main:local:new-chat': { role: 'bot', text: 'Quoted' } },
    createChat: async () => ({ id: 'fixture-chat' }),
    setDraft: (bot: string, chat: string, text: string) => {
      const key = `${bot}:${chat}`;
      if (text) state.drafts[key] = text; else delete state.drafts[key];
    },
    updateDraftFiles: (bot: string, chat: string, update: (list: any[]) => any[]) => {
      state.draftFiles[`${bot}:${chat}`] = update(state.draftFiles[`${bot}:${chat}`] ?? []);
    },
    setReplyTo: (bot: string, chat: string, reply: any) => { state.replyTo[`${bot}:${chat}`] = reply; },
    sendMessage: async (bot: string, chat: string, text: string, opts?: any) => { state.sent.push({ bot, chat, text, opts }); },
    sent: [] as Sent[],
    toasts: [] as any[],
    toast: (toast: any) => { state.toasts.push(toast); },
  };
  const store = {
    draftKey: (bot: string, chat: string) => `${bot}:${chat}`,
    useApp: { getState: () => state },
  };
  const load = (file: string, modules: Record<string, any>) => {
    const result: any = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: result, require: (name: string) => modules[name] ?? {} });
    return result;
  };
  const landing = load('../src/lib/landingChat.ts', { './store': store });
  const attach = load('../src/lib/attach.ts', {
    'react-native': { Platform: { OS: 'web' } },
    './haptics': { haptic: { light() {}, error() {} } },
    './media': { preparePhoto: async (f: any) => f, uploadFile: () => { throw new Error('not used'); } },
    './store': store,
  });
  return { state, ...landing, ...attach };
}

test('home send creates a chat, posts there, and never touches the home chat', async () => {
  const h = harness();
  const created: string[] = [];
  h.state.createChat = async (bot: string) => { created.push(bot); return { id: 'fixture-chat' }; };
  const target = h.newChatTarget('main', () => {});
  const destination = await target();
  assert.equal(destination, 'fixture-chat');
  await h.sendDraft('main', destination!, h.state.drafts['main:fixture-chat']);
  assert.deepEqual(created, ['main']);
  assert.deepEqual(h.state.sent.map((m: Sent) => m.chat), ['fixture-chat']);
  assert.deepEqual(h.state.sent.map((m: Sent) => m.text), ['Hello there']);
  assert.equal(h.state.sent[0].opts.attachments[0].id, 'u1');
  assert.equal(h.state.sent[0].opts.replyTo.text, 'Quoted');
  assert.equal(h.state.sent.some((m: Sent) => m.chat === 'general'), false);
  const index = readFileSync(new URL('../src/app/(tabs)/index.tsx', import.meta.url), 'utf8');
  assert.match(index, /const targetChat = newChatId \?\? NEW_CHAT_DRAFT/);
  assert.match(index, /prepareChat: !newChatId \? prepareChat : undefined/);
});

test('home send clears the local draft and posts the text once', async () => {
  const h = harness();
  const target = h.newChatTarget('main', () => {});
  const destination = await target();
  assert.equal(h.state.drafts['main:local:new-chat'], undefined);
  assert.equal(h.state.drafts['main:fixture-chat'], 'Hello there');
  await h.sendDraft('main', destination!, h.state.drafts['main:fixture-chat']);
  assert.equal(h.state.drafts['main:fixture-chat'], undefined);
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.sent[0].text, 'Hello there');
  assert.equal(h.state.sent[0].text.includes('Hello thereHello there'), false);
});

test('a failed chat creation keeps the home draft and creates nothing', async () => {
  const h = harness();
  h.state.network = false;
  h.state.createChat = async () => { throw new Error('offline'); };
  const target = h.newChatTarget('main', () => {});
  assert.equal(await target(), null);
  assert.equal(h.state.drafts['main:local:new-chat'], 'Hello there');
  assert.equal(h.state.drafts['main:general'], 'Home draft');
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.state.toasts.length, 1);
  assert.equal(h.state.toasts[0].title, "You're offline");
  assert.match(h.state.toasts[0].body, /can't be started while offline/);
});
