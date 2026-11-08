import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, hooks, jsx, anything, nodes, button, server, tick } from './helpers/serverUpdateHarness.ts';
const job: any = { id: 'j', kind: 'winglet_update', device_id: 'd', state: 'running', detail: {}, updated_at: 1, created_at: 1 };
function harness() {
  const host = hooks(); let close = 0, poll: any; const replies: any[] = [];
  const exports = load('components/JobSheet.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ActivityIndicator: 'Activity', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    'react-native-reanimated': { default: { View: 'AnimatedView', Text: 'AnimatedText' }, FadeIn: anything },
    '../lib/api': { api: () => new Promise((r) => replies.push(r)) }, '../lib/haptics': { haptic: anything },
    '../lib/motion': { spring: {}, useReducedMotion: () => true }, '../lib/store': { useApp: () => undefined },
    '../lib/themeContext': { useTheme: () => anything, makeStyles: () => () => anything }, './icons': anything,
    './Sheet': { Sheet: 'Sheet' }, './ui': { Button: 'Button', Footnote: 'Footnote', ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader' },
  }, { setInterval: (f: any) => { poll = f; return 1; }, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
  return { render: (value: any = job) => host.render(() => exports.JobSheet({ server, job: value, onClose: () => close++ })), close: () => close, poll: () => poll(), replies, unmount: host.unmount };
}
test('running progress has no Hide action and terminal Done is the only acknowledgement', () => {
  const h = harness(); let tree = h.render();
  assert.equal(tree.props.dismissible, false);
  tree.props.onClose(); assert.equal(h.close(), 0);
  assert.ok(!nodes(tree).some((n) => n.props?.title === 'Hide'));
  tree = h.render({ ...job, state: 'failed', updated_at: 2 }); tree = h.render({ ...job, state: 'failed', updated_at: 2 });
  assert.equal(tree.props.dismissible, false); tree.props.onClose(); assert.equal(h.close(), 0);
  button(tree, 'Done')(); assert.equal(h.close(), 1);
});
test('late running poll cannot revert a terminal result', async () => {
  const h = harness(); h.render(); h.poll();
  h.render({ ...job, state: 'succeeded', updated_at: 3 });
  h.replies[0]({ job: { ...job, updated_at: 2 } }); await tick();
  const tree = h.render({ ...job, state: 'succeeded', updated_at: 3 });
  assert.ok(nodes(tree).some((n) => n.props?.title === 'Done'));
});

for (const dismissible of [false, true]) test(`Sheet backdrop/back/gesture respect dismissible=${dismissible}`, () => {
  const host = hooks(); let closes = 0; const handlers: any = {};
  const pan: any = new Proxy({}, { get: (_t, key) => (...args: any[]) => { handlers[key] = args[0]; return pan; } });
  const exports = load('components/Sheet.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Keyboard: anything, Modal: 'Modal', Platform: { OS: 'web' }, Pressable: 'Pressable', StyleSheet: anything, Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'react-native-gesture-handler': { Gesture: { Pan: () => pan }, GestureDetector: 'Gesture', GestureHandlerRootView: 'Root', ScrollView: 'ScrollView' },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, runOnJS: (f: any) => f, useAnimatedStyle: () => ({}), useSharedValue: (value: any) => ({ value }), withSpring: () => 0, withTiming: () => 0 },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }, '../lib/appLock': { useLock: () => false },
    '../lib/haptics': { haptic: anything }, '../lib/motion': { spring: {}, useReducedMotion: () => true },
    '../lib/themeContext': { useTheme: () => anything, makeStyles: () => () => anything }, './icons': anything, './ui': { Tap: 'Tap' },
  });
  const tree = host.render(() => exports.Sheet({ visible: true, dismissible, onClose: () => closes++, children: null }));
  tree.props.onRequestClose();
  nodes(tree).find((n) => n.type === 'Pressable')?.props.onPress?.();
  handlers.onEnd({ translationY: 200, velocityY: 1000 });
  assert.equal(closes, dismissible ? 3 : 0);
  assert.equal(nodes(tree).some((n) => n.type === 'Tap'), dismissible);
});
