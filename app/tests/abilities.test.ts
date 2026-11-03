import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/abilities.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Map, Set, URL });

test('categories and catalog names read as words', () => {
  assert.equal(exports.categoryLabel('software-development'), 'Software development');
  assert.equal(exports.categoryLabel('autonomous-ai-agents'), 'AI agents');
  assert.equal(exports.categoryLabel(null), 'General');
  assert.equal(exports.prettyName('aws-knowledge'), 'AWS Knowledge');
  assert.equal(exports.prettyName('hugging_face'), 'Hugging Face');
});

test('search needs every word, anywhere', () => {
  assert.ok(exports.matches('git merge', 'arbiter', 'Neutral arbiter for merge conflicts', ['Git', 'Kanban']));
  assert.ok(!exports.matches('git rebase', 'arbiter', 'merge conflicts', ['Git']));
  assert.ok(exports.matches('  ', 'anything'));
});

test('skill sources use explicit safe URLs and otherwise identify the source', () => {
  assert.equal(exports.skillSource({ identifier: 'official/a/one', source_url: 'https://example.org/one' }).url, 'https://example.org/one');
  assert.equal(exports.skillSource({ identifier: 'official/a/two', source_url: null }).label, 'official/a/two');
  assert.equal(exports.skillSource({ identifier: 'official/a/two', source_url: 'javascript:alert(1)' }).url, null);
  assert.equal(exports.skillSource({ provenance: 'hub', identifier: 'github/test', source_url: 'https://example.org/source' }).url, 'https://example.org/source');
});

test('skills group by category, sorted', () => {
  const groups = exports.byCategory([
    { name: 'zotero', category: 'research' }, { name: 'arxiv', category: 'research' }, { name: 'notes', category: null },
  ]);
  assert.deepEqual(Array.from(groups, (g: any) => [g.title, g.items.map((i: any) => i.name).join()]),
    [['General', 'notes'], ['Research', 'arxiv,zotero']]);
});

test('a server is described by where it lives', () => {
  assert.equal(exports.serverPlace({ url: 'https://mcp.deepwiki.com/mcp', command: null }), 'mcp.deepwiki.com');
  assert.equal(exports.serverPlace({ url: null, command: 'npx', args: ['-y', 'notes-mcp'] }), 'npx -y notes-mcp');
});

test('required keys and sign-in', () => {
  const entry = { required_env: [{ name: 'A', prompt: '', required: true }, { name: 'B', prompt: '', required: false }] };
  assert.deepEqual([...exports.missingEnv(entry, { A: '  ' })], ['A']);
  assert.deepEqual([...exports.missingEnv(entry, { A: 'x' })], []);
  assert.ok(exports.signsIn({ transport: 'http', auth: 'oauth', source: 'config' }));
  assert.ok(!exports.signsIn({ transport: 'http', auth: 'oauth', source: 'config', custom: true }));
  assert.ok(!exports.signsIn({ transport: 'http', auth: 'oauth', source: 'plugin' }));
  assert.ok(!exports.signsIn({ transport: 'stdio', auth: null, source: 'config' }));
});

test('long descriptions shorten to their first sentence', () => {
  assert.equal(exports.shortDescription('web_search, web_extract'), 'web_search, web_extract');
  assert.equal(exports.shortDescription('Talk to other agents. INBOUND: exposes Hermes as an agent.\nMore'), 'Talk to other agents.');
  const long = exports.shortDescription('word '.repeat(60));
  assert.ok(long.length <= 110 && long.endsWith('…'));
  assert.equal(exports.shortDescription(null), '');
});
