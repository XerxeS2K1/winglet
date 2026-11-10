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

const command = 'grep -R "marker" /srv/projects | head -n 200 ' + 'x'.repeat(300);
const approval = {
  kind: 'approval', title: 'Approval needed', body: command + '\n\nFind every project marker.',
  item_id: 'item 1', choices: ['once', 'deny'], sig: { once: 'once-sig', deny: 'deny-sig' }, shade_expires: 200,
};

test('an enabled approval keeps the full body and offers both actions', () => {
  const view = actions.notificationModel(approval, { shadeApprovals: true, now: 100 });
  assert.equal(view.body, approval.body);
  assert.ok(view.body.length > 180);
  assert.deepEqual(Array.from(view.actions, (a: any) => a.id), ['approve', 'decline']);
  assert.equal(view.actions[0].sig, 'once-sig');
});

test('the switch off leaves Decline alone; choices still decide what exists', () => {
  const off = actions.notificationModel(approval, { shadeApprovals: false, now: 100 });
  assert.deepEqual(Array.from(off.actions, (a: any) => a.id), ['decline']);
  const noDeny = actions.notificationModel({ ...approval, choices: ['once'] }, { shadeApprovals: true, now: 100 });
  assert.deepEqual(Array.from(noDeny.actions, (a: any) => a.id), ['approve']);
});

test('an expired approval and an unoffered choice have no approve button', () => {
  assert.deepEqual(Array.from(actions.notificationModel(approval, { shadeApprovals: true, now: 201 }).actions,
    (a: any) => a.id), ['decline']);
  const always = actions.notificationModel({ ...approval, choices: ['always', 'deny'] },
    { shadeApprovals: true, now: 100 });
  assert.deepEqual(Array.from(always.actions, (a: any) => a.id), ['decline']);
});

test('an ordinary message gets a text reply action', () => {
  const view = actions.notificationModel({ kind: 'message', title: 'Hermes', body: 'Done', chat_id: 'general' },
    { shadeApprovals: false });
  assert.deepEqual(Array.from(view.actions, (a: any) => ({ id: a.id, textInput: a.textInput })), [{ id: 'reply', textInput: true }]);
});

test('approve and deny post only the short-lived signature', () => {
  const approve = actions.approvalResponseRequest('item 1', 'once', 'once-sig');
  assert.equal(approve.path, '/api/inbox/item%201/respond');
  assert.deepEqual(JSON.parse(JSON.stringify(approve.body)), { choice: 'once', sig: 'once-sig' });
  assert.equal(approve.headers.Authorization, undefined);
  const deny = actions.approvalResponseRequest('item 1', 'deny', 'deny-sig');
  assert.deepEqual(JSON.parse(JSON.stringify(deny.body)), { choice: 'deny', sig: 'deny-sig' });
});

test('quick reply posts an ordinary authenticated message with an idempotency key', () => {
  const reply = actions.quickReplyRequest('general', 'hello', 'cid', 'device-token');
  assert.equal(reply.path, '/api/chats/general/messages');
  assert.deepEqual(JSON.parse(JSON.stringify(reply.body)), { text: 'hello', client_id: 'cid' });
  assert.equal(reply.headers.Authorization, 'Bearer device-token');
  const older = actions.quickReplyFallbackRequest('general', 'hello', 'cid', 'device-token');
  assert.equal(older.path, '/api/messages');
  assert.deepEqual(JSON.parse(JSON.stringify(older.body)), { chat_id: 'general', text: 'hello', client_id: 'cid' });
});

test('a refused signature surfaces an error instead of failing silently', () => {
  const refused = actions.actionOutcome(401, { error: 'That approval expired.' });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, 'That approval expired.');
  assert.equal(actions.actionOutcome(200).ok, true);
  assert.match(actions.actionOutcome(0).message, /Couldn't reach/);
});

function settingsHarness() {
  const calls: any[] = [];
  const lib = load('../src/lib/shadeApprovals.ts', {
    './api': {
      api: async (_server: any, path: string) => ({ shade_approvals: false, epoch: 3, can_enable: true, path }),
      signedApi: async (_server: any, method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return { shade_approvals: body.shade_approvals, epoch: 4, can_enable: true };
      },
    },
  });
  return { lib, calls };
}

test('the settings toggle reads the one field and sends it back', async () => {
  const h = settingsHarness();
  const loaded = await h.lib.loadShadeApprovals({ id: 's', url: 'https://box' });
  assert.equal(loaded.shade_approvals, false);
  const saved = await h.lib.saveShadeApprovals({ id: 's', url: 'https://box' }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ method: 'PUT', path: '/api/push/shade', body: { shade_approvals: true } }]);
  assert.equal(saved.epoch, 4);
});

test('can_enable false disables the toggle and explains why', () => {
  const h = settingsHarness();
  const member = h.lib.shadeToggleView({ shade_approvals: false, epoch: 1, can_enable: false }, { role: 'member', verified: true });
  assert.equal(member.disabled, true);
  assert.match(member.note, /Only an owner/);
  const unverified = h.lib.shadeToggleView({ shade_approvals: false, epoch: 1, can_enable: false }, { role: 'owner', verified: false });
  assert.equal(unverified.disabled, true);
  assert.match(unverified.note, /Verify this phone/);
  const owner = h.lib.shadeToggleView({ shade_approvals: true, epoch: 1, can_enable: true }, { role: 'owner', verified: true });
  assert.equal(owner.disabled, false);
  assert.equal(owner.value, true);
});
