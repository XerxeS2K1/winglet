import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/withMinify.js');

// The release block exactly as `expo prebuild` writes it (Expo 57 / React Native 0.86 template).
const RELEASE = `        release {
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }`;

test('with the switch the release build minifies and shrinks; the template switches stay in charge otherwise', () => {
  const out: string = plugin.applyMinify(RELEASE);
  assert.match(out, /minifyEnabled\(enableMinifyInReleaseBuilds \|\| System\.getenv\('WINGLET_MINIFY'\) == '1'\)/);
  assert.match(out, /shrinkResources\(enableShrinkResources\.toBoolean\(\) \|\| System\.getenv\('WINGLET_MINIFY'\) == '1'\)/);
  // Nothing else in the block changed, so an unset variable leaves today's build as it was.
  const lines = RELEASE.split('\n');
  const changed = out.split('\n').filter((l, i) => l !== lines[i]);
  assert.equal(changed.length, 2);
  assert.ok(out.includes('proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"'));
});

test('applying it twice changes nothing more, and an unknown layout fails loudly', () => {
  const once = plugin.applyMinify(RELEASE);
  assert.equal(plugin.applyMinify(once), once);
  assert.throws(() => plugin.applyMinify('android { }'), /unexpected android\/app\/build\.gradle layout/);
});

test('the keep rules are appended once, after what prebuild wrote', () => {
  const base = '# generated\n-keep class com.swmansion.reanimated.** { *; }\n';
  const out: string = plugin.applyRules(base);
  assert.ok(out.startsWith(base));
  assert.equal(plugin.applyRules(out), out);
  assert.equal(plugin.applyRules('').includes('WINGLET_MINIFY'), true);
});

test('every Winglet Android module package is kept, and no library is kept wholesale', () => {
  const rules: string = plugin.RULES;
  const packages = new Set<string>();
  for (const dir of readdirSync(new URL('../modules/', import.meta.url))) {
    const src = new URL(`../modules/${dir}/android/src/main/java/`, import.meta.url);
    const walk = (u: URL, parts: string[]) => {
      for (const e of readdirSync(u, { withFileTypes: true })) {
        if (e.isDirectory()) walk(new URL(`${e.name}/`, u), [...parts, e.name]);
        else if (e.name.endsWith('.kt') && parts.length) packages.add(parts.slice(0, parts[0] === 'expo' ? 3 : 2).join('.'));
      }
    };
    walk(src, []);
  }
  assert.ok(packages.size >= 6, `found ${[...packages]}`);
  for (const p of packages) assert.ok(rules.includes(`-keep class ${p}.** { *; }`), `${p} is not kept`);
  assert.doesNotMatch(rules, /-keep class (expo\.modules|com\.facebook\.react|androidx|com\.google)\.\*\*/);
});

test('the plugin is registered, and the default build is left alone without the variable', () => {
  const config = readFileSync(new URL('../app.config.js', import.meta.url), 'utf8');
  assert.match(config, /'\.\/plugins\/withMinify'/);
  assert.match(readFileSync(new URL('../plugins/withMinify.js', import.meta.url), 'utf8'), /OFF by default/);
});
