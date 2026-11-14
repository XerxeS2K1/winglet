import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// The real Composer, with device services replaced: sending from a landing
// must ask prepareChat for the destination and hand that chat to sendDraft.
function harness(submit?: (...args: any[]) => Promise<boolean>) {
  let sounds = 0;
  let callbacks = 0;
  const prepared: string[] = [];
  const sent: any[] = [];
  const state: any = {
    drafts: { 'bot:local:new-chat': 'Hello there' }, draftFiles: {}, replyTo: {},
    runtime: { bot: { status: 'online', info: { features: { uploads: true, voice: false } } } },
    setDraft: (server: string, chat: string, text: string) => { state.drafts[`${server}:${chat}`] = text; },
    setReplyTo: (server: string, chat: string, reply: any) => { state.replyTo[`${server}:${chat}`] = reply; },
    updateDraftFiles: () => {}, sendMessage: async (...args: any[]) => { sent.push(args); },
    toast: () => {},
  };
  let cursor = 0;
  const memory: any[] = [];
  const hooks = {
    useState(value: any) { const i = cursor++; if (!(i in memory)) memory[i] = value; return [memory[i], (next: any) => { memory[i] = typeof next === 'function' ? next(memory[i]) : next; }]; },
    useRef(value: any) { const i = cursor++; return memory[i] ??= { current: value }; },
    useEffect() {},
  };
  const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });
  const jsx = (type: any, props: any) => ({ type, props });
  const store = { draftKey: (server: string, chat: string) => `${server}:${chat}`, useApp: Object.assign((select: any) => select(state), { getState: () => state }) };
  const modules: Record<string, any> = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'android' } },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, cancelAnimation() {}, FadeIn: fallback, FadeOut: fallback,
      useAnimatedStyle: () => ({}), useSharedValue: (v: any) => ({ value: v }), withRepeat: (v: any) => v, withSequence: (...v: any[]) => v, withTiming: (v: any) => v, ZoomIn: fallback },
    'react-native-gesture-handler': { Gesture: fallback, GestureDetector: 'GestureDetector' },
    'expo-image': { Image: 'Image' },
    '../lib/store': store,
    '../lib/attach': { attachFiles() {}, canSend: () => true, removeFile() {}, retryFile() {},
      sendDraft: (server: string, chat: string, text: string) => { sent.push({ server, chat, text }); return submit ? submit(server, chat, text) : Promise.resolve(true); } },
    '../lib/actions': { stopTask: async () => false },
    '../lib/commands': { loadCommands: async () => [], matchCommands: () => [] },
    '../lib/composerFocus': { focusRegisteredComposer() {}, registerComposer: () => () => {} },
    '../lib/haptics': { haptic: { light() {}, error() {}, selection() {} } },
    '../lib/media': { pickFiles: async () => [], pickMedia: async () => [], takePhoto: async () => [], formatDuration: () => '' },
    '../lib/motion': { easeOut: (x: any) => x, useReducedMotion: () => true },
    '../lib/prefs': { usePrefs: (select: any) => select({ prefs: { busyMode: 'queue' }, update() {} }) },
    '../lib/sounds': { sound: { sent() { sounds++; } } },
    '../lib/themeContext': { makeStyles: () => () => new Proxy({}, { get: () => undefined }), useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }) },
    '../lib/text': { plainText: (s: string) => s },
    '../lib/voiceNote': { useVoiceNote: () => ({ recording: false, durationMs: 0, start() {}, finish() {} }) },
    './FallbackStrip': { FallbackStrip: 'FallbackStrip' },
    './Glass': { Glass: 'Glass' },
    './ModelSheet': { ModelButton: 'ModelButton' },
    './Sheet': { Sheet: 'Sheet', SheetAction: 'SheetAction' },
    './TaskProgress': { TaskProgress: 'TaskProgress' },
    './ThemedTextInput': { TextInput: 'TextInput' },
    './ui': { Chip: 'Chip', Tap: (props: any) => jsx('Tap', props), Toggle: 'Toggle' },
    '../features/live-voice/VoicePanel': { VoicePanel: 'VoicePanel' },
  };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (name: string) => modules[name] ?? fallback, setTimeout });
  const render = () => {
    cursor = 0;
    return exports.Composer({ server: { id: 'bot', bot: { title: 'Atlas' } }, chatId: 'local:new-chat', busy: false,
      bottomInset: 0, target: null, onHeight() {}, placeholder: 'Message', onSent() { callbacks++; },
      prepareChat: async () => { prepared.push('prepare'); return 'fixture-chat'; } });
  };
  return { render, prepared, sent, state, sounds: () => sounds, callbacks: () => callbacks };
}

function find(tree: any, match: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (match(tree)) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) {
    const result = find(child, match);
    if (result) return result;
  }
}

test('the landing composer sends through prepareChat and posts to the new chat', async () => {
  const h = harness();
  const send = find(h.render(), (node) => node.props?.accessibilityLabel === 'Send');
  assert.ok(send, 'the send control must be on screen');
  await send.props.onPress();
  assert.deepEqual(h.prepared, ['prepare']);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chat, 'fixture-chat');
  assert.equal(h.sent[0].text, 'Hello there');
  assert.equal(h.sent.some((m: any) => m.chat === 'general'), false);
});

for (const accepted of [false, true]) {
  test(`mounted Composer reports sent only on admission: ${accepted}`, async () => {
    let release!: (value: boolean) => void;
    const wait = new Promise<boolean>(resolve => { release = resolve; });
    const h = harness(() => wait);
    const button = find(h.render(), node => node.props?.accessibilityLabel === 'Send');
    const first = button.props.onPress();
    let duplicate: Promise<any> | undefined;
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(h.sounds(), 0, 'pending submission must not sound sent');
      assert.equal(h.callbacks(), 0);
      const pending = find(h.render(), node => node.props?.accessibilityState?.disabled === true && node.props?.onPress);
      assert.ok(pending, 'pending submission disables the mounted send control');
      duplicate = button.props.onPress();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(h.sent.length, 1, 'double tap before admission is blocked');
    } finally { release(accepted); await Promise.allSettled([first, duplicate]); }
    assert.equal(h.sounds(), accepted ? 1 : 0);
    assert.equal(h.callbacks(), accepted ? 1 : 0);
    assert.equal(find(h.render(), node => node.props?.accessibilityLabel === 'Send').props.disabled, false);
  });
}
