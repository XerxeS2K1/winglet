import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sentByScript } from '../src/lib/messages.ts';
import type { Message } from '../src/lib/types.ts';

const base = { id: 'm1', chat_id: 'general', status: 'final', created_at: 1, updated_at: 1 } as const;
const msg = (role: Message['role'], meta: Message['meta']): Message => ({ ...base, role, text: 'hi', meta }) as Message;

test('a bot message a script posted is marked', () => {
  assert.equal(sentByScript(msg('bot', { origin: 'local-send' })), true);
});

test('the bot\'s own words and other messages are not', () => {
  assert.equal(sentByScript(msg('bot', {})), false);
  assert.equal(sentByScript(msg('bot', { routine: 'Morning news' })), false);
  assert.equal(sentByScript(msg('user', { origin: 'local-send' })), false);
});
