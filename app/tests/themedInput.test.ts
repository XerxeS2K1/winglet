import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(file: string, modules: any) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => { assert.ok(id in modules, `Unexpected import ${id}`); return modules[id]; } });
  return exports;
}
const themes = load('../src/lib/theme.ts', { 'react-native': { Platform: { select: (o: any) => o.default } } });
const flat = (s: any): any => Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(flat)) : s;
function harness() {
  let t = themes.buildTheme('dark', 'iris'), os = 'android';
  const jsx = (type: any, props: any) => ({ type, props });
  const { TextInput } = load('../src/components/ThemedTextInput.tsx', {
    react: { forwardRef: (fn: any) => fn }, 'react/jsx-runtime': { jsx },
    'react-native': { TextInput: 'NativeInput', Platform: { get OS() { return os; } } },
    '../lib/themeContext': { useTheme: () => t },
  });
  return { render: (props: any = {}, ref: any = null) => TextInput(props, ref), set: (theme: any, platform: string) => { t = theme; os = platform; } };
}
test('native input defaults follow selected theme in light and all dark tones / six accents on every platform', () => {
  const h = harness();
  for (const scheme of ['light', 'dark']) for (const tone of ['charcoal', 'graphite', 'black']) for (const accent of themes.ACCENT_NAMES) for (const os of ['android', 'ios', 'web']) {
    const t = themes.buildTheme(scheme, accent, tone); h.set(t, os); const node = h.render();
    assert.equal(node.type, 'NativeInput'); assert.equal(flat(node.props.style).color, t.colors.text);
    assert.equal(node.props.placeholderTextColor, t.colors.textTertiary); assert.equal(node.props.selectionColor, t.colors.accent);
    assert.equal(node.props.cursorColor, os === 'android' ? t.colors.accent : undefined);
    assert.equal(node.props.selectionHandleColor, os === 'android' ? t.colors.accent : undefined);
    assert.equal(node.props.keyboardAppearance, os === 'ios' ? scheme : undefined);
  }
});
test('input preserves imperative ref, handlers, security, accessibility, autocomplete, multiline and caller overrides', () => {
  const h = harness(), ref = { current: null }, onChangeText = () => {}, onSelectionChange = () => {}, onKeyPress = () => {};
  const props = { value: 'Draft', multiline: true, secureTextEntry: true, autoComplete: 'off', accessibilityLabel: 'Password',
    readOnly: true, showSoftInputOnFocus: false, onChangeText, onSelectionChange, onKeyPress,
    selectionColor: '#123456', cursorColor: '#234567', selectionHandleColor: '#345678', keyboardAppearance: 'light',
    placeholderTextColor: '#456789', style: [{ fontSize: 19 }, { color: '#567890' }] };
  const node = h.render(props, ref);
  assert.equal(node.props.ref, ref);
  for (const [key, value] of Object.entries(props)) if (key !== 'style') assert.equal(node.props[key], value, key);
  assert.equal(flat(node.props.style).color, '#567890'); assert.equal(flat(node.props.style).fontSize, 19);
});
function files(root: URL): URL[] { return readdirSync(root, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(new URL(e.name + '/', root)) : /\.tsx?$/.test(e.name) ? [new URL(e.name, root)] : []); }
test('AST audit: every actual native TextInput uses the shared wrapper, no app-owned native alerts', () => {
  const raw: string[] = [], alerts: string[] = []; let inputs = 0;
  for (const file of files(new URL('../src/', import.meta.url))) {
    const code = readFileSync(file, 'utf8'), source = ts.createSourceFile(file.pathname, code, ts.ScriptTarget.Latest, true, file.pathname.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const nativeInputNames = new Set<string>(), nativeAlertNames = new Set<string>(), nativeNamespaces = new Set<string>();
    for (const node of source.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'react-native') {
      const binding = node.importClause?.namedBindings;
      if (binding && ts.isNamespaceImport(binding)) nativeNamespaces.add(binding.name.text);
      if (binding && ts.isNamedImports(binding)) for (const name of binding.elements) {
        if ((name.propertyName ?? name.name).text === 'TextInput' && !name.isTypeOnly && !node.importClause?.isTypeOnly) nativeInputNames.add(name.name.text);
        if ((name.propertyName ?? name.name).text === 'Alert') nativeAlertNames.add(name.name.text);
      }
    }
    function visit(n: ts.Node) {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName.getText(source); if (tag === 'TextInput') inputs++;
        if ((nativeInputNames.has(tag) || [...nativeNamespaces].some((name) => tag === name + '.TextInput')) && !file.pathname.endsWith('/components/ThemedTextInput.tsx')) raw.push(file.pathname + ':' + source.getLineAndCharacterOfPosition(n.getStart()).line);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['alert', 'prompt'].includes(n.expression.name.text)) {
        const owner = n.expression.expression.getText(source);
        if (nativeAlertNames.has(owner) || [...nativeNamespaces].some((name) => owner === name + '.Alert')) alerts.push(file.pathname);
      }
      ts.forEachChild(n, visit);
    }
    visit(source);
  }
  assert.ok(inputs >= 8, `inventory unexpectedly narrow: ${inputs}`);
  assert.deepEqual(raw, [], 'raw native inputs bypass the selected theme'); assert.deepEqual(alerts, [], 'app-owned Alert bypasses the selected theme');
});
