import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type: any, props: any) => ({ type, props });
function load(file: string, modules: any) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => { assert.ok(id in modules, `Unexpected import ${id}`); return modules[id]; } });
  return exports;
}
const themes = load('../src/lib/theme.ts', { 'react-native': { Platform: { select: (o: any) => o.default } } });
const flatten = (s: any): any => Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(flatten)) : s ?? {};
function nodes(n: any): any[] { return n && typeof n === 'object' ? [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)] : []; }

test('actual ThemeProvider resolves explicit and system choices and drives chrome independently of opposite system mode', () => {
  let system = 'light', mode = 'dark', accent = 'iris', darkTone = 'charcoal', background = '';
  const { ThemeProvider } = load('../src/lib/themeContext.tsx', {
    react: { createContext: () => ({ Provider: 'Provider' }), useContext: () => {}, useMemo: (f: any) => f(), useEffect: (f: any) => f() },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'android' }, StyleSheet: {}, useColorScheme: () => system },
    'expo-navigation-bar': { NavigationBar: 'NavigationBar' }, 'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-system-ui': { setBackgroundColorAsync: (color: string) => { background = color; return Promise.resolve(); } },
    'react-native-reanimated': { ReducedMotionConfig: 'ReducedMotionConfig', ReduceMotion: {} },
    './prefs': { usePrefs: (f: any) => f({ prefs: { theme: mode, accent, darkTone, motion: 'system' } }) }, './theme': themes,
  });
  for (mode of ['light', 'dark', 'system']) for (system of ['light', 'dark']) for (darkTone of themes.DARK_TONES) for (accent of themes.ACCENT_NAMES) {
    const tree = ThemeProvider({ children: 'content' }), expected = mode === 'system' ? system : mode;
    const t = tree.props.value; assert.equal(t.scheme, expected); assert.equal(t.accentName, accent);
    assert.equal(t.colors.bg, themes.buildTheme(expected, accent, darkTone).colors.bg); assert.equal(background, t.colors.bg);
    assert.equal(nodes(tree).find((n) => n.type === 'StatusBar')?.props.style, expected === 'dark' ? 'light' : 'dark');
    assert.equal(nodes(tree).find((n) => n.type === 'NavigationBar')?.props.style, expected === 'dark' ? 'dark' : 'light');
  }
});

test('actual Sheet and action rows use selected palette and constrained scrolling for narrow/short screens and long copy', () => {
  let t = themes.buildTheme('dark', 'iris'), width = 320, height = 480, locked = false;
  const gesture: any = new Proxy({}, { get: () => () => gesture });
  const modules: any = {
    react: { Children: {}, cloneElement: () => {}, isValidElement: () => false, useEffect: () => {}, useState: (value: any) => [value, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Modal: 'Modal', View: 'View', Text: 'Text', Pressable: 'Pressable', Keyboard: {}, Platform: { OS: 'android' },
      StyleSheet: { hairlineWidth: 1, absoluteFill: { position: 'absolute' } }, useWindowDimensions: () => ({ width, height }) },
    'react-native-gesture-handler': { Gesture: { Pan: () => gesture }, GestureDetector: 'GestureDetector', GestureHandlerRootView: 'GestureHandlerRootView', ScrollView: 'ScrollView' },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, useSharedValue: (value: any) => ({ value }), useAnimatedStyle: (f: any) => f(), runOnJS: (f: any) => f },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) },
    '../lib/appLock': { useLock: (f: any) => f({ locked }) }, '../lib/haptics': { haptic: { selection: () => {} } },
    '../lib/motion': { spring: { snappy: {} }, useReducedMotion: () => true },
    '../lib/themeContext': { useTheme: () => t, makeStyles: (f: any) => () => f(t) }, './icons': { X: 'X' }, './ui': { Tap: 'Tap' },
  };
  const { Sheet, SheetAction } = load('../src/components/Sheet.tsx', modules);
  for (const scheme of ['light', 'dark']) for (const tone of themes.DARK_TONES) for (const accent of themes.ACCENT_NAMES) {
    t = themes.buildTheme(scheme, accent, tone);
    for (const dimensions of [[320, 480], [320, 240], [1000, 800]]) {
      [width, height] = dimensions;
      let closes = 0; const onClose = () => { closes++; };
      const action = SheetAction({ label: 'Continue '.repeat(12), onPress: onClose });
      const copy = jsx('Text', { children: 'Long battery explanation '.repeat(40), style: { color: t.colors.textSecondary } });
      const tree = Sheet({ visible: true, onClose, title: 'Keep Winglet connected?', scrollable: true, children: [copy, action] });
      const all = nodes(tree), styles = all.map((n) => flatten(n.props.style));
      assert.equal(tree.type, 'Modal'); assert.equal(tree.props.onRequestClose, onClose);
      assert.ok(styles.some((s) => s.backgroundColor === t.colors.bg)); assert.ok(styles.some((s) => s.backgroundColor === t.colors.overlay));
      const heading = all.find((n) => n.type === 'Text' && n.props.accessibilityRole === 'header'); assert.equal(flatten(heading.props.style).color, t.colors.text);
      const scroll = all.find((n) => n.type === 'ScrollView'); assert.ok(scroll); assert.equal(flatten(scroll.props.style).flexShrink, 1);
      assert.ok(styles.some((s) => s.maxHeight === height - 24 - 12));
      const label = nodes(action).find((n) => n.type === 'Text'); assert.equal(flatten(label.props.style).color, t.colors.text);
      assert.equal(label.props.numberOfLines, undefined); assert.equal(flatten(action.props.style({})).height, undefined);
      action.props.onPress(); assert.equal(closes, 1);
    }
  }
  locked = true; assert.equal(Sheet({ visible: true, onClose: () => {}, children: [] }), null);
});
