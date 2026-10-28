import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserReadService } from './user-read.ts';
import { setup, CHAT, SELF, isCode } from './kakao-session-fixture.test-helper.ts';
import { removeTestDir } from './temp-dir.test-helper.ts';

test('owner API reads an unread/agent-denied room without granting agent access or sending receipts', async t => {
  const { kakao, fake, dir } = setup({}, [], false, () => {});
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9001', type: 1, text: 'fixture unread body', sendAt: 100, raw: {} });
  fake.replies.chatLogs = [{ status: 0, messages: [], eof: true, raw: {} }];
  const before = kakao.getRoomAccess(CHAT).rule;
  const api = new UserReadService(kakao);
  const history = await api.dispatch('history', { chatId: CHAT }) as any;
  assert.ok(history.messages.some((m: any) => m.text === 'fixture unread body'));
  assert.deepEqual(kakao.getRoomAccess(CHAT).rule, before);
  await assert.rejects(kakao.getHistory(CHAT), isCode('POLICY_DENIED'));
  assert.equal(fake.calls.some(c => c.method === 'markRead'), false);
  assert.ok(!('attachment' in history.messages[0]));
});

test('owner API exposes only bounded exact-room reads, not role flags, grants, writes or generic tools', async t => {
  const { kakao, fake, dir } = setup({}, [], false, () => {}); fake.connect();
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  const api = new UserReadService(kakao);
  for (const [method, args] of [
    ['history', { chatId: CHAT, human: true }], ['history', { chatId: CHAT, limit: 100000 }],
    ['history', { chatId: '../fixture' }], ['updates', { chatId: CHAT, after: '0', visibleIds: Array(201).fill('1') }],
    ['send_message', { chatId: CHAT, text: 'do not send' }], ['tools/call', { name: 'read_messages' }],
    ['request_permission', { chatId: CHAT }]
  ] as const) await assert.rejects(api.dispatch(method, args), isCode('INVALID_ARGUMENT'));
  assert.equal(fake.calls.length, 0);
});

test('owner updates reflect deletion and cannot reveal a different room', async t => {
  const { kakao, fake, dir } = setup({}, [], false, () => {}); fake.connect();
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9001', type: 1, text: 'fixture', sendAt: 100, raw: {} });
  const api = new UserReadService(kakao);
  kakao.hideMessages(CHAT, ['9001']);
  const result = await api.dispatch('updates', { chatId: CHAT, after: '9001', visibleIds: ['9001'] }) as any;
  assert.deepEqual(result.removedIds, ['9001']); assert.deepEqual(result.messages, []);
  await assert.rejects(api.dispatch('history', { chatId: '999999' }), isCode('NOT_FOUND'));
});

test('unchanged visible messages are omitted from deltas while edits still propagate', async t => {
  const { kakao, fake, dir } = setup({}, [], false, () => {}); fake.connect();
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9001', type: 1, text: 'fixture', sendAt: 100, raw: {} });
  const api = new UserReadService(kakao);
  const initial = await api.dispatch('updates', { chatId: CHAT, after: '0', visibleIds: [] }) as any;
  const version = initial.messages[0].version;
  const same = await api.dispatch('updates', { chatId: CHAT, after: '9001', visibleIds: ['9001'], versions: { '9001': version } }) as any;
  assert.deepEqual(same.messages, []);
  // A changed version from the client must return the current stored message, without trusting its text.
  const changed = await api.dispatch('updates', { chatId: CHAT, after: '9001', visibleIds: ['9001'], versions: { '9001': '0'.repeat(24) } }) as any;
  assert.equal(changed.messages.length, 1); assert.equal(changed.messages[0].text, 'fixture');
});
