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

test('a failed server save rolls back the servers already changed, then puts the native flag back', async () => {
  const h = io(['c']);
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }, { server: C, state: off }], h);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'save failed on c');
  assert.deepEqual(Array.from(h.log), ['native:true', 'save:a:true', 'save:c:true', 'save:a:false', 'native:false']);
  // The screen shows the truth: a is back off (the rollback's answer), c never changed.
  assert.equal(r.states[0].shade_approvals, false);
  assert.deepEqual(JSON.parse(JSON.stringify(r.states[1])), off);
});

test('a failed save when switching off rolls back to on and restores the native flag to on', async () => {
  const h = io(['b']);
  const r = await shade.setActionsSwitch(false, true, [{ server: A, state: on }, { server: B, state: on }], h);
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false', 'save:b:false', 'save:a:true', 'native:true']);
  assert.equal(r.states[0].shade_approvals, true);
  assert.equal(r.states[1].shade_approvals, true);
});

test('rollback runs in reverse order, and only for servers this save changed', async () => {
  const h = io(['c']);
  const D = { id: 'd' };
  const r = await shade.saveShadeEverywhere(true, [
    { server: A, state: off }, { server: B, state: on }, { server: D, state: off }, { server: C, state: off },
  ], h.save);
  assert.equal(r.ok, false);
  // b was already on and is left alone; d then a go back, newest first.
  assert.deepEqual(Array.from(h.log), ['save:a:true', 'save:d:true', 'save:c:true', 'save:d:false', 'save:a:false']);
  assert.equal(r.states[1].shade_approvals, true);
});

test('a failure on the first server has nothing to roll back', async () => {
  const h = io(['a']);
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }, { server: C, state: off }], h);
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(h.log), ['native:true', 'save:a:true', 'native:false']);
});

test('if a rollback also fails, the error text says which server still has the new value', async () => {
  const log: string[] = [];
  const save = async (server: any, v: boolean) => {
    log.push(`save:${server.id}:${v}`);
    if (server.id === 'c') throw new Error('save failed on c');
    if (server.id === 'a' && v === false) throw new Error('offline');
    return { shade_approvals: v, epoch: 2, can_enable: true };
  };
  const natives: boolean[] = [];
  const r = await shade.setActionsSwitch(true, false, [{ server: A, state: off }, { server: C, state: off }],
    { setNative: (v: boolean) => { natives.push(v); }, save });
  assert.equal(r.ok, false);
  assert.match(r.message, /save failed on c/);
  assert.match(r.message, /could not put a back/i);
  assert.match(r.message, /offline/);
  // The phone's flag is still restored, and a keeps the value it really has.
  assert.deepEqual(natives, [true, false]);
  assert.equal(r.states[0].shade_approvals, true);
  assert.deepEqual(log, ['save:a:true', 'save:c:true', 'save:a:false']);
});

test('the small button is all-or-nothing too: a later failure rolls the earlier server back', async () => {
  const h = io(['c']);
  const r = await shade.enableApprovals([{ server: A, state: off }, { server: C, state: off }], h.save);
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(h.log), ['save:a:true', 'save:c:true', 'save:a:false']);
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
  // The exact expression: a clause that defeats the flag (for example `actionsOn || true`) must fail here.
  assert.equal(canAct.trim(), '!deviceLocked && !PushVisibility.locked && !privatePolicy && actionsOn');
  // The whole trimmed line, as canAct above: appending `|| true` to it must fail here, not only a prefix match.
  const actionsOn = source.match(/^[ \t]*(val actionsOn=[^\n]*)$/m)?.[1] ?? '';
  assert.equal(actionsOn.trim(), 'val actionsOn=getSharedPreferences("winglet-push-policy",MODE_PRIVATE).getBoolean("actions",true)');
  // Approve, Decline and Reply each depend on canAct.
  for (const name of ['approve', 'decline', 'reply']) assert.match(source, new RegExp(`val ${name}=[^\\n]*canAct`));
});

test('the module writes and reads the actions flag in the same policy file as private', () => {
  const source = kotlin('WingletPushModule.kt');
  assert.match(source, /Function\("setActions"\)\{enabled:Boolean ->\s*saveActions\(enabled\)\s*\}/);
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
  // The old notification comes down first (right after the blank-tag check), so a dropped confirmation
  // can never leave its buttons behind; blank-tag and notifications-disabled handling stay as they were.
  assert.match(confirm, /if \(tag\.isBlank\(\)\) return\n(\s*\/\/[^\n]*\n)*\s*cancel\(context, scope, tag\)\n/);
  assert.ok(confirm.search(/\n\s*cancel\(context, scope, tag\)\n/) < confirm.indexOf('manager.notify('), 'cancel comes before the confirmation is posted');
  assert.match(confirm, /if \(!manager\.areNotificationsEnabled\(\)\) return cancel\(context, scope, tag\)\n/);
  assert.equal((confirm.match(/manager\.notify\(/g) ?? []).length, 1);
  // The success path confirms; only the failure path cancels and shows the error.
  assert.match(source, /if \(message == null\) confirm\(context, scope, tag, action\) else \{\s*cancel\(context, scope, tag\)\s*fail\(context, message\)\s*\}/);
  // The confirmation never reads the typed reply or the command.
  assert.doesNotMatch(confirm, /EXTRA_REPLY|getResultsFromIntent|getStringExtra|bigText|command|optString/i);
});

// ---- the receiver re-reads the switch before it contacts the server ----

const receiverRun = () => kotlin('WingletActionReceiver.kt').match(/private fun run\([\s\S]*?\n  \}\n/)?.[0] ?? '';

test('the receiver reads the actions flag first, before the key store or any network call', () => {
  const run = receiverRun();
  assert.ok(run, 'run() exists');
  const flag = run.indexOf('getBoolean("actions", true)');
  assert.ok(flag > 0, 'run() must read the actions flag');
  for (const later of ['PushStore.read(', 'post(', 'HttpURLConnection']) {
    const at = run.indexOf(later);
    if (at >= 0) assert.ok(flag < at, `the flag must be read before ${later}`);
  }
  assert.ok(run.indexOf('post(') > flag, 'run() still posts after the check');
});

test('when the switch is off the receiver cancels that notification and shows no error', () => {
  const run = receiverRun();
  assert.match(run, /if \(!policy\.getBoolean\("actions", true\)\) return cancel\(context, scope, tag\)\n/);
  assert.match(run, /val policy = context\.getSharedPreferences\("winglet-push-policy", Context\.MODE_PRIVATE\)/);
  // The refusal is before every fail(): no error text for a switched-off phone.
  assert.ok(run.indexOf('getBoolean("actions", true)') < run.indexOf('fail('));
});

test('private previews also stop an old notification from answering', () => {
  const run = receiverRun();
  assert.match(run, /if \(policy\.getBoolean\("private", true\)\) return cancel\(context, scope, tag\)\n/);
  assert.ok(run.indexOf('getBoolean("private", true)') < run.indexOf('post('));
});

test('switching off in the module takes down notifications that carry buttons', () => {
  const source = kotlin('WingletPushModule.kt');
  const save = source.match(/private fun saveActions\([\s\S]*?\n  \}\n/)?.[0] ?? '';
  assert.ok(save, 'saveActions exists');
  assert.ok(save.indexOf('putBoolean("actions",enabled)') >= 0);
  assert.match(save, /if\(!enabled\)/);
  assert.match(save, /activeNotifications\.filter\{[^\n]*\^\[a-f0-9\]\{64\}:\[a-f0-9\]\{64\}\$[^\n]*notification\.actions\?\.isNotEmpty\(\)==true[^\n]*\}\s*\.forEach\{manager\.cancel\(it\.tag,it\.id\)\}/);
  // The flag is written before the notifications go, so nothing posts a new button meanwhile.
  assert.ok(save.indexOf('putBoolean("actions",enabled)') < save.indexOf('activeNotifications'));
});

// ---- an older native shell without setActions ----

test('approvals-only row: the owner can still switch server approvals, with a note about this build', () => {
  const view = shade.approvalsOnlyView([{ state: off, me: owner }]);
  assert.equal(view.disabled, false);
  assert.equal(view.value, false);
  assert.match(view.note, /this build cannot switch replies and Decline/i);
  assert.equal(view.enableApprovals, false);
  assert.equal(shade.approvalsOnlyView([{ state: on, me: owner }]).value, true);
  // Several servers: on only when every one this phone can change is on.
  assert.equal(shade.approvalsOnlyView([{ state: on, me: owner }, { state: off, me: owner }]).value, false);
});

test('approvals-only row: loading waits, and a member or unverified phone gets a disabled row with the reason', () => {
  const loading = shade.approvalsOnlyView([{ state: null, me: owner }]);
  assert.equal(loading.disabled, true);
  assert.match(loading.note, /Checking/);
  assert.equal(shade.approvalsOnlyView([{ state: null, me: owner, failed: true }]).disabled, true);
  const member = shade.approvalsOnlyView([{ state: noRight, me: { role: 'member', verified: true } }]);
  assert.equal(member.disabled, true);
  assert.match(member.note, /Only an owner/);
  const unverified = shade.approvalsOnlyView([{ state: noRight, me: { role: 'owner', verified: false } }]);
  assert.equal(unverified.disabled, true);
  assert.match(unverified.note, /Verify this phone/);
  assert.match(unverified.note, /this build cannot switch replies and Decline/i);
});

// ---- the row's handler: a small function the screen calls ----

function ctx(over: any = {}) {
  const log: string[] = [];
  const h = io();
  return {
    log: h.log,
    started: log,
    c: {
      view: { disabled: false }, busy: false, master: true,
      rows: [{ server: A, state: on }],
      native: { setActions: (v: boolean) => { h.log.push(`native:${v}`); } },
      save: h.save,
      begin: () => { log.push('begin'); },
      ...over,
    },
  };
}

test('the handler gives setNative the chosen value, not the old one', async () => {
  const off1 = ctx({ master: true });
  await shade.changeActions(false, off1.c);
  assert.deepEqual(Array.from(off1.log), ['native:false', 'save:a:false']);
  const on1 = ctx({ master: false, rows: [{ server: A, state: off }] });
  await shade.changeActions(true, on1.c);
  assert.deepEqual(Array.from(on1.log), ['native:true', 'save:a:true']);
});

test('the handler uses only the chosen value: the phone value is just what a failure restores', async () => {
  // Switch is on (master true) and the person picks true again: the native flag still gets the chosen value.
  const same = ctx({ master: true, rows: [{ server: A, state: off }] });
  await shade.changeActions(true, same.c);
  assert.deepEqual(Array.from(same.log), ['native:true', 'save:a:true']);
  // A failure restores `master`, not the chosen value.
  const h = io(['a']);
  const fail = ctx({ master: true, rows: [{ server: A, state: on }], save: h.save, native: { setActions: (v: boolean) => { h.log.push(`native:${v}`); } } });
  const r = await shade.changeActions(false, fail.c);
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false', 'native:true']);
});

test('the handler ignores a disabled row, a busy screen and an unknown phone value', async () => {
  for (const over of [{ view: { disabled: true } }, { busy: true }, { master: null }]) {
    const x = ctx(over);
    assert.equal(await shade.changeActions(false, x.c), null);
    assert.deepEqual(Array.from(x.log), []);
    assert.deepEqual(Array.from(x.started), []);
  }
});

test('the handler tells the screen it started only once it has accepted the change', async () => {
  const x = ctx();
  await shade.changeActions(false, x.c);
  assert.deepEqual(Array.from(x.started), ['begin']);
});

test('on a shell without setActions the handler saves the servers only and never touches native', async () => {
  const x = ctx({ native: {}, master: null, rows: [{ server: A, state: off }, { server: B, state: noRight }] });
  const r = await shade.changeActions(true, x.c);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(x.log), ['save:a:true']);
  const none = ctx({ native: null, master: null, rows: [{ server: A, state: on }] });
  await shade.changeActions(false, none.c);
  assert.deepEqual(Array.from(none.log), ['save:a:false']);
  // A disabled approvals-only row is still ignored.
  const blocked = ctx({ native: {}, master: null, view: { disabled: true } });
  assert.equal(await shade.changeActions(true, blocked.c), null);
});

// ---- source checks: the settings screen wiring ----

const screen = () => readFileSync(new URL('../src/app/notifications.tsx', import.meta.url), 'utf8');

test('the settings screen has one phone-wide row with the agreed title, not one per server', () => {
  const source = screen();
  assert.equal((source.match(/Reply and approve from notifications for this phone/g) ?? []).length >= 1, true);
  assert.doesNotMatch(source, /ShadeApprovalsSetting/);
  assert.match(source, /<NotificationActionsSetting servers=\{servers\} \/>/);
  assert.match(source, /actionsSwitchView\(/);
  assert.match(source, /approvalsOnlyView\(/);
  assert.match(source, /SHADE_PREVIEW_NOTE/);
});

test('the screen shows the row on Android whether or not the native shell has setActions', () => {
  const source = screen();
  assert.match(source, /Platform\.OS === 'android' \? <NotificationActionsSetting servers=\{servers\} \/> : null/);
  assert.doesNotMatch(source, /pushNative\?\.setActions \? <NotificationActionsSetting/);
});

test('the screen hands the person\'s chosen value and the real native module to the handler', () => {
  const source = screen();
  assert.match(source, /await changeActions\(enabled, \{/);
  assert.match(source, /native: pushNative,/);
  assert.match(source, /master,/);
  assert.match(source, /save: saveShadeApprovals,/);
  // The old inline wiring (a no-op setNative, or the old value) is gone.
  assert.doesNotMatch(source, /setNative:/);
  assert.doesNotMatch(source, /changeActions\(master/);
  assert.match(source, /onValueChange=\{change\}/);
});

// ---- the real row, rendered: the shown switch value and the in-flight guard ----
// The row (NotificationActionsSetting) is compiled from the screen's own source and rendered with
// fake useState / useRef / useEffect, the same way tests/routineHistoryScreen.test.ts does it.

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });
const sameDeps = (a: any[], b: any[]) => !!a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function rowHarness(opts: { gate?: boolean } = {}) {
  let cursor = 0;
  const hooks: any[] = [];
  const effects: (() => void)[] = [];
  const log: string[] = [];
  const release: (() => void)[] = [];
  let shown = true; // the phone's own flag, as the fake native module keeps it
  const server = { id: 'a', token: 't', bot: { title: 'Home' } };
  const native = {
    setActions: (v: boolean) => { shown = v; log.push(`native:${v}`); },
    actionsEnabled: () => shown,
  };
  const server_state = { shade_approvals: true, epoch: 1, can_enable: true };
  const store = { runtime: { a: { me: { role: 'owner', verified: true } } } };
  const modules: Record<string, any> = {
    react: {
      useState: (initial: any) => {
        const i = cursor++; if (!(i in hooks)) hooks[i] = initial;
        return [hooks[i], (v: any) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
      },
      useRef: (initial: any) => { const i = cursor++; return hooks[i] ??= { current: initial }; },
      useEffect: (callback: any, deps: any[]) => {
        const i = cursor++; const old = hooks[i];
        if (!old || !sameDeps(old.deps, deps)) { hooks[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); }
      },
    },
    'react/jsx-runtime': { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'android' }, Text: 'Text', View: 'View' },
    '../components/ui': { Toggle: 'Toggle', Button: 'Button', ListGroup: 'ListGroup', ListRow: 'ListRow', SectionHeader: 'SectionHeader' },
    '../features/encrypted-push/native': { pushNative: native },
    '../lib/store': { useApp: (select: any) => select(store), homeChat: () => null },
    '../lib/themeContext': { makeStyles: () => () => fallback, useTheme: () => fallback },
    '../lib/shadeApprovals': {
      ...shade,
      loadShadeApprovals: async () => server_state,
      // A save that waits for the test to let it finish, so a second call can arrive meanwhile.
      saveShadeApprovals: async (srv: any, v: boolean) => {
        log.push(`save:${srv.id}:${v}`);
        if (opts.gate) await new Promise<void>((resolve) => { release.push(resolve); });
        return { shade_approvals: v, epoch: 2, can_enable: true };
      },
    },
  };
  const exports: any = {};
  const source = readFileSync(new URL('../src/app/notifications.tsx', import.meta.url), 'utf8') + '\nexport { NotificationActionsSetting };';
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id: string) => modules[id] ?? fallback });
  const render = () => { cursor = 0; const tree = exports.NotificationActionsSetting({ servers: [server] }); while (effects.length) effects.shift()!(); return tree; };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const find = (tree: any, type: string): any => {
    if (Array.isArray(tree)) { for (const t of tree) { const f = find(t, type); if (f) return f; } return undefined; }
    if (!tree || typeof tree !== 'object') return undefined;
    return tree.type === type ? tree : find(tree.props?.children, type) ?? find(tree.props?.right, type);
  };
  const toggle = (tree: any) => find(tree, 'Toggle') ?? find(find(tree, 'ListRow')?.props?.right, 'Toggle');
  return { render, settle, toggle, log, release };
}

async function loaded(h: ReturnType<typeof rowHarness>) {
  h.render(); await h.settle();   // first render starts the reads, the effect fills the state
  return h.render();
}

test('the row shows the switch the person chose once the change is saved', async () => {
  const h = rowHarness();
  const first = await loaded(h);
  assert.equal(h.toggle(first).props.value, true);
  assert.equal(h.toggle(first).props.disabled, false);
  await h.toggle(first).props.onValueChange(false);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false']);
  const after = h.render();
  assert.equal(h.toggle(after).props.value, false, 'the switch stays where the person put it');
  await h.toggle(after).props.onValueChange(true);
  assert.equal(h.toggle(h.render()).props.value, true);
});

test('a second activation before the screen redraws is ignored: one native write, one server walk', async () => {
  const h = rowHarness({ gate: true });
  const first = await loaded(h);
  const change = h.toggle(first).props.onValueChange; // the same closure both taps would hit: no re-render between them
  const calls: Promise<unknown>[] = [];
  try {
    calls.push(change(false));
    calls.push(change(false));
    await h.settle();
    assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false'], 'the second call must not write or walk again');
  } finally {
    for (let i = 0; i < 5; i++) { h.release.splice(0).forEach((f) => f()); await h.settle(); }
  }
  await Promise.all(calls);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false'], 'still one write and one walk');
  // Once the first change is over the row accepts a new one.
  const again: Promise<unknown>[] = [];
  try {
    again.push(h.toggle(h.render()).props.onValueChange(true));
    await h.settle();
  } finally {
    for (let i = 0; i < 5; i++) { h.release.splice(0).forEach((f) => f()); await h.settle(); }
  }
  await Promise.all(again);
  assert.deepEqual(Array.from(h.log), ['native:false', 'save:a:false', 'native:true', 'save:a:true']);
});
