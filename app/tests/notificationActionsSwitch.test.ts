import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function load(file: string, modules: Record<string, unknown> = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => modules[id] });
  return exports;
}

const actions = load('../src/lib/notificationActions.ts');
const shade = load('../src/lib/shadeApprovals.ts', { './api': { api: async () => ({}), signedApi: async () => ({}) } });
const kotlin = (name: string) => readFileSync(new URL(
  `../modules/winglet-push/android/src/main/java/expo/modules/wingletpush/${name}`, import.meta.url), 'utf8');
const ids = (view: any) => Array.from(view.actions, (a: any) => a.id);

const approval = {
  kind: 'approval', title: 'Approval needed', body: 'rm -rf build',
  item_id: 'item1', choices: ['once', 'deny'], sig: { once: 'o', deny: 'd' }, shade_expires: 200,
};
const message = { kind: 'message', title: 'Hermes', body: 'Done', chat_id: 'general' };

// ---- notificationModel: the per-phone master switch ----

test('the master switch off removes every action from an approval and from a chat note', () => {
  assert.deepEqual(ids(actions.notificationModel(approval, { shadeApprovals: true, now: 100, actions: false })), []);
  assert.deepEqual(ids(actions.notificationModel(message, { shadeApprovals: true, actions: false })), []);
});

test('the master switch on, or left out, keeps the existing buttons', () => {
  assert.deepEqual(ids(actions.notificationModel(approval, { shadeApprovals: true, now: 100, actions: true })), ['approve', 'decline']);
  assert.deepEqual(ids(actions.notificationModel(message, { shadeApprovals: false, actions: true })), ['reply']);
  // Default true, so replies keep working after an upgrade.
  assert.deepEqual(ids(actions.notificationModel(message, { shadeApprovals: false })), ['reply']);
  assert.deepEqual(ids(actions.notificationModel(approval, { shadeApprovals: false, now: 100 })), ['decline']);
});

test('the master switch off still shows the title and the whole body', () => {
  const view = actions.notificationModel(approval, { shadeApprovals: true, now: 100, actions: false });
  assert.equal(view.title, 'Approval needed');
  assert.equal(view.body, 'rm -rf build');
});

// ---- the toggle view, every state ----

const owner = { role: 'owner', verified: true };
const on = { shade_approvals: true, epoch: 1, can_enable: true };
const off = { shade_approvals: false, epoch: 1, can_enable: true };
const noRight = { shade_approvals: false, epoch: 1, can_enable: false };

test('loading: the switch waits, and says it is checking', () => {
  const view = shade.actionsSwitchView(true, [{ state: null, me: owner }]);
  assert.equal(view.disabled, true);
  assert.match(view.note, /Checking/);
  assert.equal(view.enableApprovals, false);
  const unknownNative = shade.actionsSwitchView(null, [{ state: on, me: owner }]);
  assert.equal(unknownNative.disabled, true);
  // One server answered and another has not: still loading.
  assert.equal(shade.actionsSwitchView(true, [{ state: on, me: owner }, { state: null, me: owner }]).disabled, true);
});

test('a server that could not be read does not lock the switch', () => {
  const view = shade.actionsSwitchView(true, [{ state: null, me: owner, failed: true }]);
  assert.equal(view.disabled, false);
  assert.equal(view.value, true);
  assert.equal(view.enableApprovals, false);
});

test('verified owner, switch on, server on: nothing extra to offer', () => {
  const view = shade.actionsSwitchView(true, [{ state: on, me: owner }]);
  assert.deepEqual({ value: view.value, disabled: view.disabled, enableApprovals: view.enableApprovals },
    { value: true, disabled: false, enableApprovals: false });
  assert.match(view.note, /Approve, Decline and Reply/);
});

test('verified owner, switch on, server off: a note and the button to turn approvals on', () => {
  const view = shade.actionsSwitchView(true, [{ state: off, me: owner }]);
  assert.equal(view.value, true);
  assert.equal(view.disabled, false);
  assert.equal(view.enableApprovals, true);
  assert.match(view.note, /Approve is off/);
});

test('one server on and another off still offers the button', () => {
  assert.equal(shade.actionsSwitchView(true, [{ state: on, me: owner }, { state: off, me: owner }]).enableApprovals, true);
});

test('switch off: no button and no promise of buttons, whatever the server says', () => {
  for (const state of [on, off, noRight]) {
    const view = shade.actionsSwitchView(false, [{ state, me: owner }]);
    assert.equal(view.value, false);
    assert.equal(view.disabled, false);
    assert.equal(view.enableApprovals, false);
    assert.match(view.note, /Off/);
  }
});

test('member: the switch still works for reply and decline, and approving needs a verified owner', () => {
  const view = shade.actionsSwitchView(true, [{ state: noRight, me: { role: 'member', verified: true } }]);
  assert.equal(view.value, true);
  assert.equal(view.disabled, false);
  assert.equal(view.enableApprovals, false);
  assert.match(view.note, /verified owner/);
  assert.match(view.note, /Reply/);
});

test('unverified phone: the switch works and the note says to verify', () => {
  const view = shade.actionsSwitchView(true, [{ state: noRight, me: { role: 'owner', verified: false } }]);
  assert.equal(view.disabled, false);
  assert.equal(view.enableApprovals, false);
  assert.match(view.note, /Verify this phone/);
});

test('a phone whose role is not known yet gets the plain verified-owner note', () => {
  const view = shade.actionsSwitchView(true, [{ state: noRight, me: undefined }]);
  assert.equal(view.enableApprovals, false);
  assert.match(view.note, /verified owner/);
});

// ---- saving: native flag plus every server this phone may change ----

function io(failOn: string[] = []) {
  const log: string[] = [];
  return {
    log,
    setNative: (v: boolean) => { log.push(`native:${v}`); },
    save: async (server: any, v: boolean) => {
      log.push(`save:${server.id}:${v}`);
      if (failOn.includes(server.id)) throw new Error(`save failed on ${server.id}`);
      return { shade_approvals: v, epoch: 2, can_enable: true };
    },
  };
}
const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };

test('switching on sets the native flag, then saves every server this phone can change', async () => {
  const h = io();
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }, { server: B, state: noRight }, { server: C, state: off }], h);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(h.log), ['native:true', 'save:a:true', 'save:c:true']);
  assert.equal(r.states[0].shade_approvals, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.states[1])), noRight);
  assert.equal(r.states[2].shade_approvals, true);
});

test('switching off sets the native flag false and saves false on every server it can', async () => {
  const h = io();
  const r = await shade.setActionsSwitch(false, true, [{ server: A, state: on }, { server: B, state: noRight }], h);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false']);
  assert.equal(r.states[0].shade_approvals, false);
});

test('a server already in the wanted state is not written again', async () => {
  const h = io();
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: on }], h);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(h.log), ['native:true']);
});

test('a phone that cannot change any server only flips the native flag', async () => {
  const h = io();
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: noRight }, { server: B, state: null }], h);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(h.log), ['native:true']);
});

test('a failed server save puts the native flag back and returns the error text', async () => {
  const h = io(['c']);
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }, { server: C, state: off }], h);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'save failed on c');
  assert.deepEqual(Array.from(h.log), ['native:true', 'save:a:true', 'save:c:true', 'native:false']);
  // The server that did save keeps its new state, so the screen shows the truth.
  assert.equal(r.states[0].shade_approvals, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.states[1])), off);
});

test('a failed save when switching off restores the native flag to on', async () => {
  const h = io(['a']);
  const r = await shade.setActionsSwitch(false, true, [{ server: A, state: on }], h);
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false', 'native:true']);
});

test('a native write that throws stops before any server is touched', async () => {
  const h = io();
  h.setNative = () => { throw new Error('native refused'); };
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }], h);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'native refused');
  assert.deepEqual(Array.from(h.log), []);
});

test('the small button saves approvals on for every server that can, and leaves the native flag alone', async () => {
  const h = io();
  const r = await shade.enableApprovals([{ server: A, state: off }, { server: B, state: on }, { server: C, state: noRight }], h.save);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(h.log), ['save:a:true']);
});

// ---- source checks: native side (Kotlin cannot be compiled here) ----

test('the native service needs the master flag in canAct, so Approve, Decline and Reply all follow it', () => {
  const source = kotlin('WingletPushService.kt');
  const canAct = source.match(/val canAct=([^\n]+)/)?.[1] ?? '';
  assert.ok(canAct.includes('actionsOn'), 'canAct must include the master flag');
  assert.match(source, /val actionsOn=getSharedPreferences\("winglet-push-policy",MODE_PRIVATE\)\.getBoolean\("actions",true\)/);
});

test('the module writes and reads the actions flag in the same policy file as private', () => {
  const source = kotlin('WingletPushModule.kt');
  assert.match(source, /Function\("setActions"\)\{enabled:Boolean/);
  assert.match(source, /getSharedPreferences\("winglet-push-policy",Context\.MODE_PRIVATE\)\.edit\(\)\.putBoolean\("actions",enabled\)\.apply\(\)/);
  assert.match(source, /Function\("actionsEnabled"\)\{[^}]*getBoolean\("actions",true\)/);
  const native = readFileSync(new URL('../src/features/encrypted-push/native.ts', import.meta.url), 'utf8');
  assert.match(native, /setActions\??:\(enabled:boolean\)=>void/);
  assert.match(native, /actionsEnabled\??:\(\)=>boolean/);
});

test('a successful answer re-posts a generic, action-less notification that removes itself', () => {
  const source = kotlin('WingletActionReceiver.kt');
  const confirm = source.match(/private fun confirm\([\s\S]*?\n  \}\n/)?.[0] ?? '';
  assert.ok(confirm, 'confirm() exists');
  assert.match(confirm, /PushStore\.noteTag\(scope, tag\), 1/);
  assert.match(confirm, /Notification\.Builder\(context, PushChannels\.REPLIES\)/);
  assert.match(confirm, /setTimeoutAfter\(4_000\)/);
  assert.doesNotMatch(confirm, /addAction|RemoteInput|setStyle|BigText/);
  for (const word of ['"Approved"', '"Declined"', '"Sent"']) assert.ok(source.includes(word), word);
  // The success path confirms; only the failure path cancels and shows the error.
  assert.match(source, /if \(message == null\) confirm\(context, scope, tag, action\) else \{\s*cancel\(context, scope, tag\)\s*fail\(context, message\)\s*\}/);
  // The confirmation never reads the typed reply or the command.
  assert.doesNotMatch(confirm, /EXTRA_REPLY|getResultsFromIntent|getStringExtra|bigText|command|optString/i);
});

// ---- source checks: the settings screen ----

test('the settings screen has one phone-wide row with the agreed title, not one per server', () => {
  const source = readFileSync(new URL('../src/app/notifications.tsx', import.meta.url), 'utf8');
  assert.equal((source.match(/Reply and approve from notifications for this phone/g) ?? []).length >= 1, true);
  assert.doesNotMatch(source, /Approve from notifications"/);
  assert.doesNotMatch(source, /ShadeApprovalsSetting/);
  assert.match(source, /<NotificationActionsSetting servers=\{servers\} \/>/);
  assert.match(source, /actionsSwitchView\(/);
  assert.match(source, /setActionsSwitch\(/);
  assert.match(source, /SHADE_PREVIEW_NOTE/);
});
