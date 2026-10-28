import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpConversationReader, type ToolClient } from './mcp-reader.ts';
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
  const client: ToolClient = { async callTool(name) { calls.push(name); throw error; } };
  const reader = new McpConversationReader(client);
  await assert.rejects(reader.history('2'), e => e === error);
  await assert.rejects(reader.updates('2', '0', []), e => e === error);
  assert.deepEqual(calls, ['read_messages', 'read_messages']);
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
