// Fresh-user product contract in a temporary fixture; never connects to Kakao.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AgentSendJournal, AgentSendService, ApprovalStore, ApproverRegistry, DailyActionLimit, KakaoDb, RecipientPermissions, RoomAccessPolicy, SendPolicy } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { ElicitationApprovals } from './client-approval.ts';
import { registerAgentMessageTools } from './tools/agent-messages.ts';
import { agentControlAdapter, registerPermissionTools } from './tools/agent-operations.ts';
import { registerChatDiscoveryTools } from './tools/chat-discovery.ts';
import { registerCoreReadTools } from './tools/core-read.ts';
import { registerAgentPublicationTools } from './tools/agent-publications.ts';
import { registerAgentMutationTools } from './tools/agent-mutations.ts';
import { registerNamedOperationTools, grantViews } from './tools/agent-operations.ts';
import { registerChatTools } from './tools/chats.ts';
import { registerFriendsTools } from './tools/friends.ts';
import { registerMessageInboxTools } from './tools/message-inbox.ts';
import { loadConfig, type ReadApproval } from '@kakao-max/core';
import { runSetup } from './setup.ts';

const SOURCE = '123456789', DEST = '987654321';
test('fresh setup -> named room -> read approval -> first send approval -> idempotent acknowledgement', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-journey-'));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), rooms = new RoomAccessPolicy(db);
  const approvals = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  const policy = new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  const chats = [{ id: SOURCE, title: '프로젝트 방', titleSource: 'shared', type: 'MultiChat', memberCount: 2, unreadCount: 0 },
    { id: DEST, title: '요약 받을 방', titleSource: 'shared', type: 'MultiChat', memberCount: 2, unreadCount: 0 }];
  let reads = 0, sends = 0, installs = 0;
  const account = { getState: () => ({ connected: true }), selfUserId: '111111111', listChats: () => chats,
    getChatInfo: async (id: string) => ({ chatId: id, title: chats.find(c => c.id === id)!.title, titleSource: 'shared', isGroup: true, members: [] }),
    getRoomAccess: (id: string) => ({ rule: rooms.rule(id) }), setRoomAccess: (id: string, rule: unknown) => rooms.set(id, rule),
    listRoomAccess: () => rooms.listRules(), tightenRoomAccess: (id: string, rule: unknown) => rooms.tighten(id, rule),
    createReadGrant: (grant: Parameters<RoomAccessPolicy['createReadGrant']>[0]) => rooms.createReadGrant(grant),
    listReadGrants: () => rooms.listReadGrants(), revokeReadGrant: (id: string) => rooms.revokeReadGrant(id),
    getHistory: async (id: string, options: ReadApproval) => { rooms.take(id, options, 1); reads++; return { messages: [] }; }
  };
  const sendService = new AgentSendService({ principal: 'local-mcp', journal, approvals, recipients: recipients, policy,
    adapter: { accountId: () => account.selfUserId, connected: () => true, context: () => 'fixture context', send: async () => { sends++; return { status: 0, logId: '123' }; } } });
  const engine = new AgentOperationEngine({ principal: 'local-mcp', journal, definitions: AGENT_CONTROL_DEFINITIONS, approvals,
    adapter: agentControlAdapter(account as never, policy, recipients, new DailyActionLimit(journal.db, { action: 'add_friend', limit: 10, timeZone: 'UTC' })), rateLimit: () => policy.describe().rateLimit });
  const server = new McpStdioServer({ name: 'journey-fixture', version: '0' });
  server.setClientApproval(new ElicitationApprovals(approvals, Date.now, recipients));
  registerChatDiscoveryTools(server, account as never); registerAgentMessageTools(server, () => sendService);
  const views = grantViews(account as never, recipients);
  registerPermissionTools(server, { engine: () => engine, grants: () => views, policy });
  registerCoreReadTools(server, { kakao: account as never, policy, config: loadConfig({ env: {}, envPath: path.join(root, '.env.local') }), groups: [], grants: () => views });
  const registerGroups = (target: McpStdioServer) => {
    registerNamedOperationTools(target, () => engine); registerChatTools(target, account as never);
    registerFriendsTools(target, account as never); registerMessageInboxTools(target, account as never);
  };
  registerAgentPublicationTools(server, () => { throw new Error('publication not exercised here'); });
  registerAgentMutationTools(server, () => { throw new Error('mutation not exercised here'); });
  registerGroups(server);
  const grouped = new McpStdioServer({ name: 'groups', version: '0', toolGroups: ['chats', 'friends', 'events'] });
  registerGroups(grouped);
  const listTools = async (target: McpStdioServer): Promise<Array<{ name: string }>> => {
    const input = new PassThrough(), output = new PassThrough();
    const result = new Promise<Array<{ name: string }>>(resolve => output.once('data', chunk => resolve(JSON.parse(chunk.toString()).result.tools)));
    target.serveConnection(input, output);
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    try { return await result; } finally { output.end(); }
  };
  const extra = await listTools(grouped), core = await listTools(server);
  assert.ok(extra.some(tool => tool.name === 'mark_read'));
  assert.ok(extra.some(tool => tool.name === 'claim_message_events'));
  assert.equal(core.length, 16);
  assert.equal(core.some(tool => tool.name === 'mark_read'), false);
  const answers = ['1', '', '127.0.0.1:18787']; let setupOutput = '';
  await runSetup({ prompt: async () => answers.shift() ?? '', log: () => {}, output: value => { setupOutput = value; },
    configFile: path.join(root, 'settings/mcp.json'), repo: root, platform: 'linux', install: () => { installs++; return true; } });
  assert.equal(installs, 0); assert.ok(setupOutput.includes('--resilient')); assert.ok(setupOutput.includes('18787'));
  const input = new PassThrough(), output = new PassThrough(); server.serveConnection(input, output);
  t.after(() => { input.end(); output.end(); journal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let id = 0, buffer = ''; const waiting = new Map<number, (r: any) => void>();
  output.on('data', chunk => { buffer += chunk.toString(); let n;
    while ((n = buffer.indexOf('\n')) >= 0) { const r = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); waiting.get(r.id)?.(r.result); waiting.delete(r.id); }
  });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'new-user-fixture', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
  const call = (name: string, args: object, extra: object = {}) => new Promise<any>(resolve => { const next = ++id; waiting.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { _meta: meta, name, arguments: args, ...extra } }) + '\n');
  });
  const payload = (r: any) => JSON.parse(r.content[0].text);
  const approve = async (name: string, args: object) => {
    const ask = await call(name, args); assert.equal(ask.resultType, 'input_required');
    const code = /확인 코드 ([A-Z2-9]{4})/.exec(ask.inputRequests.approve.params.message)![1];
    return call(name, args, { requestState: ask.requestState, inputResponses: { approve: { action: 'accept', content: { code, remember: true } } } });
  };
  assert.equal(payload(await call('find_chat', { query: '프로젝트방' })).matches[0].chatId, SOURCE);
  const denied = await call('read_messages', { chatId: SOURCE }); assert.equal(denied.isError, true); assert.equal(reads, 0);
  assert.equal(denied.structuredContent.error.recovery.action, 'review_scope_with_person');
  const access = { requestId: randomUUID(), chatId: SOURCE, type: 'room_access', rule: { mode: 'immediate', maxMessages: 10, expiresAt: new Date(Date.now() + 600000).toISOString() } };
  assert.equal((await approve('request_permission', access)).isError, false);
  assert.equal(payload(await call('read_messages', { chatId: SOURCE })).messages.length, 0); assert.equal(reads, 1);
  assert.equal(rooms.rule(DEST).mode, 'deny', 'read permission did not spread to the recipient room');
  const message = { requestId: randomUUID(), chatId: DEST, text: 'fixture source task summary' };
  assert.equal((await approve('send_message', message)).isError, false); assert.equal(sends, 1);
  await call('send_message', message); assert.equal(sends, 1, 'same operation did not publish twice');
  assert.equal((await call('send_message', { ...message, requestId: randomUUID() })).isError, false);
  assert.equal(sends, 2, 'room permission covers a second operation without another dialog');
  assert.equal(payload(await call('revoke_permission', { permissionId: `recipient:${DEST}` })).revoked, true);
  const afterRevoke = { ...message, requestId: randomUUID() };
  const ask = await call('send_message', afterRevoke); assert.equal(ask.resultType, 'input_required');
  const empty = await call('send_message', afterRevoke, { requestState: ask.requestState, inputResponses: { approve: { action: 'accept', content: {} } } });
  assert.equal(empty.resultType, 'input_required'); assert.equal(sends, 2);
  const declined = await call('send_message', afterRevoke, { requestState: empty.requestState, inputResponses: { approve: { action: 'decline' } } });
  assert.equal(declined.structuredContent.error.code, 'POLICY_DENIED'); assert.equal(sends, 2);
  assert.equal((await call('send_message', afterRevoke)).structuredContent.error.code, 'POLICY_DENIED');

  // Manual-room grant is created by the actual control engine and spent by the actual read policy.
  const manual = { requestId: randomUUID(), chatId: SOURCE, type: 'room_access', rule: { mode: 'manual', maxMessages: 20 } };
  await approve('request_permission', manual);
  const readGrant = payload(await approve('request_permission', { requestId: randomUUID(), chatId: SOURCE, type: 'read' })).result.readGrantId;
  assert.equal((await call('read_messages', { chatId: SOURCE, limit: 1, readGrantId: readGrant })).isError, false);
  assert.equal((await call('read_messages', { chatId: SOURCE, limit: 1, readGrantId: readGrant })).structuredContent.error.code, 'POLICY_DENIED');
  assert.equal(reads, 2);

  assert.equal(payload(await call('pause', { paused: true })).paused, true);
  const blocked = { ...message, requestId: randomUUID() };
  assert.equal((await call('send_message', blocked)).structuredContent.error.code, 'POLICY_DENIED');
  const resume = { paused: false, requestId: randomUUID() };
  assert.equal(payload(await approve('pause', resume)).paused, false);
  assert.equal(sends, 2, 'pause/resume and permissions caused no external attempt');
  for (const bad of [{ ...message, confirm: true }, { ...message, approvalSignature: 'old' }])
    assert.equal((await call('send_message', bad)).structuredContent.error.code, 'INVALID_ARGUMENT');
  for (const key of ['KAKAO_MCP_PROFILE', 'KAKAO_MCP_PERMISSION_MODEL', 'KAKAO_AGENT_APPROVAL_PUBLIC_KEY_FILE'])
    assert.throws(() => loadConfig({ env: { [key]: 'legacy' }, envPath: path.join(root, '.env.local') }), { code: 'CONFIG_INVALID' });
});
