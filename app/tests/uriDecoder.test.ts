import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const queryRequire = createRequire(require.resolve('query-string'));
const decode = queryRequire('decode-uri-component');

test('the router query parser uses the fixed CommonJS decoder', () => {
  assert.equal(typeof decode, 'function');
  assert.equal(queryRequire('decode-uri-component/package.json').version, '0.5.1-winglet.1');
  const query = require('query-string');
  assert.deepEqual({ ...query.parse('name=hello+world&emoji=%F0%9F%AA%B6&bad=%FF%41&encoded=%252F') },
    { name: 'hello world', emoji: '🪶', bad: '%FFA', encoded: '%2F' });
});

test('valid text, partial UTF-8, literal percent and legacy plus behavior survive', () => {
  for (const [input, expected] of [
    ['plain+text', 'plain text'], ['%2B', '+'], ['%C3%A5', 'å'],
    ['%E0%A4%A', '%E0%A4%A'], ['%FE%FF', '\uFFFD\uFFFD'],
    ['%C2', '\uFFFD'], ['%25C2%FF', '%C2%FF'], ['100% done', '100% done'],
  ]) assert.equal(decode(input), expected);
  assert.throws(() => decode(null), TypeError);
});

test('malformed runs and many distinct replacements finish within a bounded worker', () => {
  // A separate process bounds regressions without hanging the test runner. The old
  // recursive decoder stalls on the first input; repeated replacements were quadratic.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const decode = require(${JSON.stringify(queryRequire.resolve('decode-uri-component'))});
    const invalid = '%FF'.repeat(30000);
    assert.equal(decode(invalid), invalid);
    const chunks = Array.from({ length: 20000 }, (_, i) => '%FF%41' + i.toString(16));
    const result = decode(chunks.join('!'));
    assert.equal(result, chunks.map(s => '%FFA' + s.slice(6)).join('!'));
  `], { timeout: 5000, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
