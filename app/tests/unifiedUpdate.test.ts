import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/serverUpdateHarness.ts';

const update = { version: '0.10.8', page: 'https://github.com/XerxeS2K1/winglet/releases/tag/v0.10.8', apk: 'https://example.invalid/winglet.apk' };

function harness(over: any = {}) {
  const installs: any[] = [], prompts: string[] = [];
  const deps: any = {
    authenticate: async (prompt: string) => { prompts.push(prompt); return true; },
    install: async (...args: any[]) => { installs.push(args); return 'opened'; },
    lastError: () => '',
    ...over,
  };
  const { AppUpdateFlow } = load('lib/unifiedUpdate.ts', {
    'expo-constants': { expoConfig: { version: '0.10.7' } },
    './version': load('lib/version.ts', {}),
  });
  return { flow: new AppUpdateFlow(deps), deps, installs, prompts };
}

test('one authenticated tap downloads the APK and opens the installer, nothing else', async () => {
  const h = harness();
  const outcome = await h.flow.start(update);
  assert.equal(outcome, 'opened');
  assert.deepEqual(h.prompts, ['Update Winglet']);
  assert.equal(h.installs.length, 1);
  assert.equal(h.installs[0][0].version, update.version);
  assert.equal(h.flow.error, '');
});

test('cancelling authentication downloads nothing and says approval is needed', async () => {
  const h = harness({ authenticate: async () => false });
  assert.equal(await h.flow.start(update), null);
  assert.equal(h.installs.length, 0);
  assert.match(h.flow.error, /needs your approval/i);
});

test('a download failure says download, not installer, and never opens the installer', async () => {
  const h = harness({ install: async () => 'error', lastError: () => "Couldn't download the update. Check your connection and try again." });
  assert.equal(await h.flow.start(update), 'error');
  assert.match(h.flow.error, /couldn't download/i);
  assert.doesNotMatch(h.flow.error, /installer/i);
});

test('a 4xx during the download never opens the installer', async () => {
  const h = harness({ install: async () => 'error', lastError: () => '404 Not Found' });
  assert.equal(await h.flow.start(update), 'error');
  assert.match(h.flow.error, /404/);
  assert.equal(h.installs.length, 0);
});

for (const version of ['0.10.7', '0.9.0', 'garbage', '']) test(`stale or malformed offer ${version || '(empty)'} is not an offer`, async () => {
  const h = harness();
  assert.equal(await h.flow.start({ ...update, version }), null);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.installs.length, 0);
});

test('a release without an APK opens the release page instead of the installer', async () => {
  const h = harness({ install: async () => 'browser' });
  assert.equal(await h.flow.start({ ...update, apk: undefined }), 'browser');
  assert.equal(h.installs.length, 0);
});

test('double taps share one authentication and one download', async () => {
  let release: any;
  const h = harness();
  h.deps.authenticate = (prompt: string) => { h.prompts.push(prompt); return new Promise((resolve) => { release = resolve; }); };
  const first = h.flow.start(update);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(await h.flow.start(update), null);
  release(true);
  assert.equal(await first, 'opened');
  assert.equal(h.prompts.length, 1);
  assert.equal(h.installs.length, 1);
});

test('switching away during authentication invalidates the pending download', async () => {
  let release: any;
  const h = harness();
  h.deps.authenticate = () => new Promise((resolve) => { release = resolve; });
  const pending = h.flow.start(update);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.flow.invalidate();
  release(true);
  assert.equal(await pending, null);
  assert.equal(h.installs.length, 0);
});

test('an error stays until the user clears it', async () => {
  const h = harness({ authenticate: async () => false });
  await h.flow.start(update);
  assert.match(h.flow.error, /needs your approval/i);
  h.flow.clearError();
  assert.equal(h.flow.error, '');
});

test('a successful start clears the previous error', async () => {
  const h = harness({ authenticate: async () => false });
  await h.flow.start(update);
  h.deps.authenticate = async () => true;
  await h.flow.start(update);
  assert.equal(h.flow.error, '');
  assert.equal(h.installs.length, 1);
});
