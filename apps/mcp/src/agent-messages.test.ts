import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AgentSendJournal, AgentSendService, SendPolicy } from '@kakao-max/core';
import type { KakaoSession } from '@kakao-max/core';
import { agentMessageAdapter, registerAgentMessageTools } from './tools/agent-messages.ts';
import { McpStdioServer } from './mcp-stdio.ts';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';

test('one send_message call prepares and asks; the same requestId sends after approval, uncertainty is final and contents are never read', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-message-'));
  const journal = AgentSendJournal.open(root); t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const approvals = fixtureApprovals(journal, root); let sends = 0, fail = false;
  const session = {
    selfUserId: '123456789', getState: () => ({ connected: true }), listChats: () => [{ id: '123456789', maxLogId: '9007199254740992', memberCount: 2 }],
    sendMessage: async () => { sends++; if (fail) throw new Error('fixture connection lost'); return { status: 0, logId: '9007199254740993' }; }
  } as unknown as KakaoSession;
  const policy = new SendPolicy({ ceiling: ['123456789'], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  const service = new AgentSendService({ principal: 'local-mcp', journal, policy, adapter: agentMessageAdapter(session), approvals: approvals.store });
  const server = new McpStdioServer({ name: 'fixture', version: '1' }); registerAgentMessageTools(server, () => service);
  const call = async (name: string, args: object) => {
    const input = new PassThrough(); let text = '';
    const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    const finished = new Promise<void>(resolve => server.serveConnection(input, output, resolve));
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    await finished;
    return JSON.parse(text).result;
  };
  const input = { requestId: randomUUID(), chatId: '123456789', text: 'fixture private draft' };
  const asked = await call('send_message', input);
  assert.equal(asked.structuredContent.error.code, 'APPROVAL_REQUIRED'); assert.equal(sends, 0);
  const approval = asked.structuredContent.error.details.approval;
  assert.equal(approval.requestId, input.requestId); assert.equal(JSON.parse(approval.signingText).message.text, input.text);
  assert.equal((await call('send_message', input)).structuredContent.error.code, 'APPROVAL_REQUIRED'); assert.equal(sends, 0);
  for (const removed of [{ confirm: true }, { approvalSignature: 'A'.repeat(86) + '==' }]) {
    assert.equal((await call('send_message', { ...input, ...removed })).structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  // Removed two-step tools are unknown (a JSON-RPC error, so no tool result).
  for (const gone of ['prepare_message', 'prepare_media', 'commit_operation']) assert.equal(await call(gone, input), undefined, gone);
  approvals.approve(approval);
  const result = await call('send_message', input);
  assert.equal(JSON.parse(result.content[0].text).logId, '9007199254740993');
  assert.equal((await call('send_message', input)).isError, false); assert.equal(sends, 1);
  assert.equal((await call('send_message', { ...input, text: 'changed' })).structuredContent.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call('send_message', { chatId: '123456789', text: 'missing ID' })).structuredContent.error.code, 'INVALID_ARGUMENT');
  fail = true;
  const second = { ...input, requestId: randomUUID() };
  approvals.approve((await call('send_message', second)).structuredContent.error.details.approval);
  const uncertain = await call('send_message', second);
  assert.equal(uncertain.structuredContent.error.code, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(uncertain.structuredContent.error.retryable, false); assert.equal(sends, 2);
  await call('send_message', second); assert.equal(sends, 2);
});

test('session adapter preserves reply and mention identities and rejects unknown rooms without fetching history', async () => {
  const calls: any[] = [];
  const session = { selfUserId: '123456789', getState: () => ({ connected: true }), listChats: () => [{ id: '123456789', maxLogId: '9007199254740993' }],
    sendReply: async (...args: any[]) => { calls.push(args); return { status: 0, logId: '9007199254740994' }; },
    sendWithMentions: async (...args: any[]) => { calls.push(args); return { status: 0, logId: '9007199254740995' }; }
  } as unknown as KakaoSession;
  const adapter = agentMessageAdapter(session);
  assert.throws(() => adapter.context('987654321'), { code: 'NOT_FOUND' });
  assert.match(adapter.context('123456789'), /9007199254740993/);
  await adapter.send({ chatId: '123456789', text: 'fixture', replyToLogId: '9007199254740993', replyToUserId: '9007199254740994', replyToText: 'fixture quote' });
  assert.equal(calls[0][2].logId, '9007199254740993'); assert.equal(calls[0][2].userId, '9007199254740994');
  await adapter.send({ chatId: '123456789', text: '@fixture', mentions: [{ userId: '9007199254740993', at: [1], len: 7 }] });
  assert.equal(calls[1][2][0].userId, '9007199254740993');
});
