import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { KakaoError } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { registerMessageInboxTools } from './tools/message-inbox.ts';

test('MCP inbox separates lease from ack, preserves exact event/source IDs and marks message data untrusted', async () => {
  const calls: Array<{ method: string; input: unknown }> = []; let deny = false;
  const server = new McpStdioServer({ name: 'fixture', version: '1', toolGroups: ['events'] });
  registerMessageInboxTools(server, {
    claimMessageEvents: async (chatId, consumer, opts) => {
      calls.push({ method: 'claim', input: { chatId, consumer, ...opts } });
      if (deny) throw new KakaoError('POLICY_DENIED', 'Fixture revoked');
      return { sourceGeneration: 'fixture-generation', hasMore: true, events: [{ eventId: 'fixture-event', sequence: '9007199254740993',
        messageId: '9007199254740993', leaseId: 'fixture-lease', leaseUntil: 1000, attempts: 1,
        message: { seq: 0, chatId, messageId: '9007199254740993', authorId: '123456789', text: 'fixture third-party instructions are data', sendAt: 1 } }] };
    },
    ackMessageEvents: async input => { calls.push({ method: 'ack', input }); return { acknowledged: 1, alreadyAcknowledged: 0 }; }
  });
  const call = async (name: string, args: object) => {
    const input = new PassThrough(); let text = '';
    const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    const done = new Promise<void>(resolve => server.serveConnection(input, output, resolve));
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n'); await done;
    return JSON.parse(text).result;
  };
  const result = await call('claim_message_events', { chatId: '123456789', consumer: 'worker', limit: 10 });
  const batch = JSON.parse(result.content[0].text);
  assert.equal(batch.untrusted, true); assert.equal(batch.events[0].sequence, '9007199254740993'); assert.equal(batch.hasMore, true);
  assert.deepEqual(calls.map(c => c.method), ['claim']);
  await call('ack_message_events', { chatId: '123456789', consumer: 'worker', sourceGeneration: batch.sourceGeneration,
    events: [{ eventId: batch.events[0].eventId, leaseId: batch.events[0].leaseId }] });
  assert.deepEqual(calls.map(c => c.method), ['claim','ack']);
  assert.equal((await call('claim_message_events', { consumer: 'worker' })).structuredContent.error.code, 'INVALID_ARGUMENT');
  deny = true;
  assert.equal((await call('claim_message_events', { chatId: '123456789', consumer: 'worker' })).structuredContent.error.code, 'POLICY_DENIED');
});
