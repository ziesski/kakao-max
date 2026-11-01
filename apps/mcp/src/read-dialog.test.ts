// read_messages on a room that is not open asks the person inside the same call; never connects to Kakao.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AgentSendJournal, ApprovalStore, ApproverRegistry, DailyActionLimit, KakaoDb, RecipientPermissions, RoomAccessPolicy, SendPolicy, loadConfig, type ReadApproval } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { ElicitationApprovals } from './client-approval.ts';
import { agentControlAdapter, grantViews } from './tools/agent-operations.ts';
import { registerCoreReadTools } from './tools/core-read.ts';

const ROOM = '123456789', OTHER = '987654321';

function harness(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-dialog-'));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), rooms = new RoomAccessPolicy(db);
  const approvals = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  const policy = new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  const chats = [{ id: ROOM, title: '프로젝트 방', type: 'MultiChat', memberCount: 3, unreadCount: 0 }, { id: OTHER, title: '다른 방', type: 'MultiChat', memberCount: 3, unreadCount: 0 }];
  const reads: ReadApproval[] = [];
  const account = { getState: () => ({ connected: true }), selfUserId: '111111111', listChats: () => chats,
    getRoomAccess: (id: string) => ({ rule: rooms.rule(id) }), setRoomAccess: (id: string, rule: unknown) => rooms.set(id, rule),
    listRoomAccess: () => rooms.listRules(), tightenRoomAccess: (id: string, rule: unknown) => rooms.tighten(id, rule),
    createReadGrant: (grant: Parameters<RoomAccessPolicy['createReadGrant']>[0]) => rooms.createReadGrant(grant),
    listReadGrants: () => rooms.listReadGrants(), revokeReadGrant: (id: string) => rooms.revokeReadGrant(id),
    getHistory: async (id: string, options: ReadApproval & { limit: number }) => { rooms.take(id, options, options.limit); reads.push(options); return { messages: [] }; }
  };
  const engine = new AgentOperationEngine({ principal: 'local-mcp', journal, definitions: AGENT_CONTROL_DEFINITIONS, approvals,
    adapter: agentControlAdapter(account as never, policy, recipients, new DailyActionLimit(journal.db, { action: 'add_friend', limit: 10, timeZone: 'UTC' })), rateLimit: () => policy.describe().rateLimit });
  const server = new McpStdioServer({ name: 'read-dialog-fixture', version: '0' });
  server.setClientApproval(new ElicitationApprovals(approvals, Date.now, recipients, { allowRead: id => { rooms.set(id, { mode: 'immediate' }); } }));
  const views = grantViews(account as never, recipients);
  registerCoreReadTools(server, { kakao: account as never, policy, config: loadConfig({ env: {}, envPath: path.join(root, '.env.local') }), groups: [], grants: () => views, engine: () => engine });
  const input = new PassThrough(), output = new PassThrough(); server.serveConnection(input, output);
  t.after(() => { input.end(); output.end(); journal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let id = 0, buffer = ''; const waiting = new Map<number, (r: any) => void>();
  output.on('data', chunk => { buffer += chunk.toString(); let n;
    while ((n = buffer.indexOf('\n')) >= 0) { const r = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); waiting.get(r.id)?.(r.result); waiting.delete(r.id); }
  });
  const meta = (dialog: boolean) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'dialog-fixture', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': dialog ? { elicitation: { form: {} } } : {} });
  const call = (args: object, extra: object = {}, dialog = true) => new Promise<any>(resolve => { const next = ++id; waiting.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { _meta: meta(dialog), name: 'read_messages', arguments: args, ...extra } }) + '\n');
  });
  const codeOf = (ask: any) => /확인 코드 ([A-Z2-9]{4})/.exec(ask.inputRequests.approve.params.message)![1];
  const answer = (args: object, ask: any, content: object) => call(args, { requestState: ask.requestState, inputResponses: { approve: { action: 'accept', content } } });
  return { call, codeOf, answer, rooms, reads, journal, recipients };
}

test('one read_messages call asks once; "this time" leaves the room closed, "always" opens it', { timeout: 5000 }, async t => {
  const h = harness(t), args = { chatId: ROOM, limit: 5 };
  const ask = await h.call(args);
  assert.equal(ask.resultType, 'input_required');
  const form = ask.inputRequests.approve.params;
  assert.ok(form.message.includes('대화방 읽기') && form.message.includes('프로젝트 방'));
  assert.ok(form.requestedSchema.properties.remember, 'the dialog offers "always for this room"');
  const once = await h.answer(args, ask, { code: h.codeOf(ask) });
  assert.equal(once.isError, false);
  assert.equal(h.reads.length, 1); assert.equal(h.reads[0].readGrant?.tool, 'read_messages');
  assert.equal(h.rooms.rule(ROOM).mode, 'deny', 'a one-time read does not change the room rule');

  const again = await h.call(args);
  assert.equal(again.resultType, 'input_required', 'the next read asks again');
  const declined = await h.call(args, { requestState: again.requestState, inputResponses: { approve: { action: 'decline' } } });
  assert.equal(declined.structuredContent.error.code, 'POLICY_DENIED'); assert.equal(h.reads.length, 1);

  const third = await h.call(args);
  const wrong = await h.answer(args, third, { code: '' });
  assert.equal(wrong.resultType, 'input_required', 'an empty code asks again for the same operation');
  assert.equal((await h.answer(args, wrong, { code: h.codeOf(wrong), remember: true })).isError, false);
  assert.equal(h.rooms.rule(ROOM).mode, 'immediate'); assert.equal(h.reads.length, 2);
  assert.equal((await h.call(args)).isError, false, 'an opened room reads without a dialog');
  assert.equal(h.reads.length, 3); assert.equal(h.reads[2].readGrant, undefined);
  assert.equal(h.rooms.rule(OTHER).mode, 'deny', 'opening one room does not spread');
});

test('the read dialog can also allow replies to this room, and only when the person ticks it', { timeout: 5000 }, async t => {
  const h = harness(t), args = { chatId: ROOM, limit: 5 };
  const ask = await h.call(args);
  const reply = ask.inputRequests.approve.params.requestedSchema.properties.reply;
  assert.equal(reply.type, 'boolean'); assert.equal(reply.default, false);
  assert.ok(ask.inputRequests.approve.params.message.includes('답장도 묻지 않고 보내기'));
  assert.equal((await h.answer(args, ask, { code: h.codeOf(ask) })).isError, false);
  assert.equal(h.recipients.list().length, 0, 'an unticked reply box grants nothing');

  const again = await h.call(args);
  assert.equal((await h.answer(args, again, { code: '', reply: true })).resultType, 'input_required', 'no code, no grant');
  assert.equal(h.recipients.list().length, 0);
  assert.equal((await h.answer(args, again, { code: h.codeOf(again), reply: true })).isError, false);
  assert.equal(h.recipients.get(ROOM)?.approver, 'client:dialog-fixture');
  assert.equal(h.recipients.get(OTHER), undefined, 'the reply permission covers only this room');
  assert.equal(h.rooms.rule(ROOM).mode, 'deny', 'allowing replies does not open the room for reading');
});

test('without a dialog the answer names the requestId to repeat; an agent-supplied confirmRead is still refused', { timeout: 5000 }, async t => {
  const h = harness(t);
  const refused = await h.call({ chatId: OTHER }, {}, false);
  assert.equal(refused.structuredContent.error.code, 'APPROVAL_REQUIRED');
  const requestId = /requestId "([0-9a-f-]{36})"/.exec(refused.content[0].text)?.[1];
  assert.ok(requestId, 'the error tells the agent which requestId to repeat');
  assert.equal(h.journal.get(requestId!)?.state, 'prepared');
  assert.equal(h.reads.length, 0);
  assert.equal((await h.call({ chatId: OTHER, confirmRead: true }, {}, false)).structuredContent.error.code, 'INVALID_ARGUMENT');
});
