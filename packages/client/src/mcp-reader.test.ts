import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpConversationReader, type ToolClient } from './mcp-reader.ts';
import { Conversation } from './conversation.ts';
const message = (id: string, text = 'fixture') => ({ messageId: id, authorId: '1', text });
function fixture() {
  const calls: { name: string; args: any }[] = [];
  let response: any;
  const client: ToolClient = { async callTool(name, args) { calls.push({ name, args }); return response; } };
  return { reader: new McpConversationReader(client), calls, set: (v: any) => { response = v; } };
}
test('messenger uses ordinary MCP calls and exposes the daemon mode without changing it', async () => {
  const f = fixture();
  for (const mode of ['ask', 'trust'] as const) {
    f.set({ connected: true, userId: '1', agentMode: { mode } });
    assert.deepEqual(await f.reader.status(), { connected: true, userId: '1', mode });
  }
  f.set({ chats: [{ id: '2', title: 'fixture', raw: 'omit' }] });
  assert.deepEqual(await f.reader.rooms(), [{ id: '2', title: 'fixture', type: undefined, memberCount: undefined, unreadCount: undefined }]);
  f.set({ messages: [message('10')], sync: { status: 0 } });
  await f.reader.history('2');
  assert.deepEqual(f.calls.at(-1), { name: 'read_messages', args: { chatId: '2', limit: 30 } });
  assert.ok(f.calls.every(c => ['get_status', 'list_chats', 'read_messages'].includes(c.name)));
});
test('feed cursor and message ids prevent old feed replay from expanding initial history', async () => {
  const f = fixture(); f.set({ cursor: 15, messages: [message('9'), message('10', 'updated'), message('11')] });
  const result = await f.reader.updates('2', '10', ['10'], 4);
  assert.deepEqual(result.messages.map(m => m.messageId), ['10', '11']);
  assert.equal(result.cursor, 15);
  assert.deepEqual(f.calls.at(-1), { name: 'read_messages', args: { chatId: '2', mode: 'recent', sinceSeq: 4 } });
  assert.deepEqual(result.removedIds, []);
});
test('policy denials propagate unchanged with no fallback, grant or implicit trust', async () => {
  const error = Object.assign(new Error('fixture policy'), { code: 'ROOM_NOT_READ' });
  const calls: string[] = [];
  const client: ToolClient = { async callTool(name) { calls.push(name); if (name === 'list_chats') return {} as any; throw error; } };
  const reader = new McpConversationReader(client);
  await assert.rejects(reader.history('2'), e => e === error);
  await assert.rejects(reader.updates('2', '0', []), e => e === error);
  assert.deepEqual(calls, ['list_chats', 'read_messages', 'read_messages']);
});
test('incomplete history and malformed cursors fail explicitly', async () => {
  const f = fixture();
  f.set({ messages: [message('10')], sync: { error: 'fixture failure' } });
  await assert.rejects(f.reader.history('2'), { code: 'NETWORK' });
  for (const cursor of [undefined, -1, 0.5, 3]) {
    f.set({ messages: [], cursor });
    await assert.rejects(f.reader.updates('2', '10', [], 4), { code: 'INVALID_RESPONSE' });
  }
});


test('explicit refresh recovers a failed room open after a phone read without marking read or retrying polls', async () => {
  let cachedUnread = 2, serverUnread: number | null = 2;
  const calls: { name: string; args: any }[] = [];
  const denied = Object.assign(new Error('fixture unread'), { code: 'ROOM_NOT_READ' });
  const client: ToolClient = { async callTool(name, args) {
    calls.push({ name, args });
    if (name === 'get_status') return { connected: true, userId: '1', agentMode: { mode: 'ask' } } as any;
    if (name === 'list_chats' && !args?.chatId) return { chats: [{ id: '2', title: 'fixture', unreadCount: cachedUnread }] } as any;
    if (name === 'list_chats') {
      assert.deepEqual(args, { chatId: '2', refreshReadState: true });
      if (serverUnread !== null) cachedUnread = serverUnread;
      return { readState: { confirmed: serverUnread === 0 } } as any;
    }
    assert.equal(name, 'read_messages');
    if (cachedUnread !== 0 || serverUnread !== 0) throw denied;
    return { messages: [message('10')], cursor: 1 } as any;
  } };
  const conversation = new Conversation(new McpConversationReader(client), {
    async identity() { return { connected: true, userId: '1' }; },
    async send() { assert.fail('no send'); }
  }, () => {});
  await conversation.start();
  await assert.rejects(conversation.open('2'), e => e === denied);
  assert.equal(conversation.active, undefined);
  serverUnread = 0; // The phone read changes only the server, not this device's cache.
  await conversation.refresh();
  assert.equal(cachedUnread, 0);
  assert.deepEqual(conversation.active, conversation.rooms[0]);
  assert.equal(conversation.live, true);
  assert.deepEqual(conversation.messages.map(m => m.messageId), ['10']);
  cachedUnread = 1; serverUnread = 1;
  await assert.rejects(conversation.poll(), e => e === denied);
  const afterFailure = calls.length;
  await conversation.poll();
  assert.equal(calls.length, afterFailure); // No automatic policy retry or metadata polling.
  await assert.rejects(conversation.refresh(), e => e === denied);
  serverUnread = null;
  await assert.rejects(conversation.refresh(), e => e === denied);
  assert.deepEqual(conversation.messages, []);
  assert.equal(conversation.live, false);
  conversation.close();
});

test('failed metadata refresh stops before requesting message contents', async () => {
  const failure = new Error('fixture metadata unavailable');
  const calls: string[] = [];
  const reader = new McpConversationReader({ async callTool(name) { calls.push(name); throw failure; } });
  await assert.rejects(reader.history('2'), e => e === failure);
  assert.deepEqual(calls, ['list_chats']);
});

test('live read receipts advance the cursor without becoming messages or stopping subsequent updates', async () => {
  const f = fixture();
  const receipt = { seq: 5, chatId: '2', authorId: '', type: -1, text: '', raw: { isReadReceipt: true, watermark: '10' } };
  f.set({ cursor: 5, messages: [receipt] });
  assert.deepEqual(await f.reader.updates('2', '10', ['10'], 4), {
    messages: [], removedIds: [], reset: false, cursor: 5
  });
  f.set({ cursor: 7, messages: [{ ...message('11'), seq: 6 }, { ...receipt, seq: 7 }] });
  const next = await f.reader.updates('2', '10', ['10'], 5);
  assert.deepEqual(next.messages.map(m => m.messageId), ['11']);
  assert.equal(next.cursor, 7);
  assert.deepEqual(f.calls.at(-1), { name: 'read_messages', args: { chatId: '2', mode: 'recent', sinceSeq: 5 } });
});

test('only explicit live read receipts are omitted; malformed message identities still fail', async () => {
  const f = fixture();
  for (const row of [
    null,
    { authorId: '1', type: 1 },
    { authorId: '1', type: -1 },
    { authorId: '1', type: 1, raw: { isReadReceipt: true } },
    { messageId: 'invalid', authorId: '1' }
  ]) {
    f.set({ cursor: 1, messages: [row] });
    await assert.rejects(f.reader.updates('2', '10', ['10']), { code: 'INVALID_RESPONSE' });
  }
  f.set({ messages: [{ type: -1, raw: { isReadReceipt: true } }] });
  await assert.rejects(f.reader.history('2'), { code: 'INVALID_RESPONSE' });
});

test('late notification generations cannot affect a replacement room subscription', async () => {
  let notify!: (method: string, params: Record<string, any>) => void, generation = 0;
  const client: ToolClient = {
    async callTool() { throw new Error('no content read in this test'); },
    async request(method) { return method === 'resources/subscribe' ? { _meta: { subscriptionId: String(++generation) } } : {}; },
    onNotification(listener) { notify = listener; return () => {}; }
  };
  const reader = new McpConversationReader(client); let changed = 0, failed = 0;
  const first = await reader.watch!('2', () => { changed++; }, () => { failed++; }); first();
  const second = await reader.watch!('2', () => { changed++; }, () => { failed++; });
  notify('notifications/resources/updated', { uri: 'kakao://rooms/2/messages', _meta: { subscriptionId: '1', error: { code: 'POLICY_DENIED' } } });
  assert.equal(changed, 0); assert.equal(failed, 0);
  notify('notifications/resources/updated', { uri: 'kakao://rooms/3/messages', _meta: { subscriptionId: '2' } });
  assert.equal(changed, 0);
  notify('notifications/resources/updated', { uri: 'kakao://rooms/2/messages', _meta: { subscriptionId: '2' } });
  assert.equal(changed, 1); second();
});
