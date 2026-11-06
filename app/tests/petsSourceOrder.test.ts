import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// `where` reads `source` inside an arrow function, so TypeScript does not flag a use before the
// declaration. On the phone `source` was then still unset on every render: the Codex Pets tab
// never took effect and the gallery sat on "Loading the gallery..." with empty tiles.
test('the Pet screen declares the selected source before it works out `where`', () => {
  const text = readFileSync(new URL('../src/app/pets.tsx', import.meta.url), 'utf8');
  const declared = text.indexOf("const [source, setSource] = useState<PetSource>");
  const used = text.indexOf('const where = ');
  assert.ok(declared >= 0 && used >= 0, 'expected both lines to exist');
  assert.ok(declared < used, '`source` must be declared before `where` reads it');
});
