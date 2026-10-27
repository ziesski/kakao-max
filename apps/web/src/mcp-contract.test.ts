// The GUI bridge against the daemon's real MCP server, tool registrations and argument
// validation, with fake services behind them: a renamed tool or a changed schema fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { KakaoError, SendPolicy } from '@kakao-max/core';
import { McpStdioServer } from '../../mcp/src/mcp-stdio.ts';
import { registerCoreReadTools } from '../../mcp/src/tools/core-read.ts';
import { registerAgentMessageTools } from '../../mcp/src/tools/agent-messages.ts';
import { registerAgentMutationTools } from '../../mcp/src/tools/agent-mutations.ts';
import { registerAgentPublicationTools } from '../../mcp/src/tools/agent-publications.ts';
import { registerNamedOperationTools } from '../../mcp/src/tools/agent-operations.ts';
import { registerChatTools } from '../../mcp/src/tools/chats.ts';
import { registerFriendsTools } from '../../mcp/src/tools/friends.ts';
import { McpBridge, type ApprovalDialog } from './mcp-bridge.ts';

const ME = '900000001', FRIEND = '900000002', OPEN = '700000001', DENIED = '700000002';
const message = { chatId: OPEN, messageId: '4001', logId: '4001', authorId: FRIEND, type: 1, text: 'fixture hello', sendAt: 1 };

/** Stands in for the daemon's dialog gate: code ABCD approves, as the real one checks its own code. */
function fixtureGate() {
  const gate = {
    approved: false, answers: [] as unknown[],
    request: (_tool: string, _args: unknown, approval: { requestId: string }, client: { elicitation: boolean }) => !client.elicitation ? undefined : {
      resultType: 'input_required' as const, requestState: `state:${approval.requestId}`,
      inputRequests: { approve: { method: 'elicitation/create' as const, params: { mode: 'form', message: '[kakao-max] 대화방 읽기 승인 요청\n<img src=x onerror=alert(1)>\n승인하려면 확인 코드 ABCD 를 입력하세요.',
        requestedSchema: { type: 'object', properties: { code: { type: 'string', title: '확인 코드', description: 'ABCD 입력' }, remember: { type: 'boolean', title: '이 방은 앞으로 묻지 않고 읽기' } }, required: ['code'] } } } }
    },
    answer: (_tool: string, _args: unknown, _state: unknown, responses: any) => {
      const r = responses?.approve; gate.answers.push(r);
      if (r?.action === 'decline') return 'declined' as const;
      if (r?.action !== 'accept') return 'cancelled' as const;
      if (r.content?.code !== 'ABCD') return 'mismatch' as const;
      gate.approved = true; return 'approved' as const;
    },
    requestIdOf: (state: unknown) => String(state).replace('state:', '')
  };
  return gate;
}

async function daemon(t: { after(fn: () => unknown): void }, opts: { gate?: ReturnType<typeof fixtureGate> } = {}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const record = (op: string, args: unknown) => { calls.push({ op, args }); };
  const kakao = {
    cursor: 0,
    getState: () => ({ connected: true, userId: ME }),
    listChats: () => [{ id: OPEN, type: 'DirectChat', title: 'fixture room', unreadCount: 1, maxLogId: '4001' }],
    refreshUnread: async () => ({ source: 'local' }),
    getUnreadSummary: () => [{ id: OPEN, unreadCount: 1 }],
    getChatInfo: async (chatId: string) => ({ chatId, title: 'fixture room', titleSource: 'custom', isGroup: false, lastLogId: '4001', members: [{ userId: ME, name: 'me' }] }),
    getRoomAccess: (chatId: string) => ({ chatId, rule: { mode: chatId === DENIED ? 'deny' : 'allow' }, defaultMode: 'allow' }),
    getHistory: async (chatId: string, opts: unknown) => { record('getHistory', { chatId, opts }); return { messages: [message] }; },
    searchMessages: async (query: string, opts: unknown) => { record('searchMessages', { query, opts }); return [message]; },
    downloadMedia: async (chatId: string, opts: unknown) => { record('downloadMedia', { chatId, opts }); return { status: 0, size: 3, data: new Uint8Array([1, 2, 3]) }; },
    listFriends: () => [{ userId: FRIEND, nickName: 'fixture friend' }],
    openDirectChat: async () => ({ chatId: OPEN, title: 'fixture room', isNew: false }),
    hideMessages: (_chatId: string, logIds: string[]) => ({ hidden: logIds, alreadyHidden: [], notStored: [] }),
    syncFriends: async () => 1
  };
  // Opening a denied room needs a person; this fixture never approves.
  const engine = {
    prepare: (action: string, requestId: string, request: unknown) => { record(`prepare:${action}`, { requestId, request }); return { requestId, action }; },
    commit: async (action: string, requestId: string) => {
      if (action === 'read_room' && !opts.gate?.approved) throw new KakaoError('APPROVAL_REQUIRED', 'fixture: not approved', { details: { approval: { requestId, signingText: '{}', expiresAt: Date.now() + 60_000 } } });
      if (action === 'read_room') return { status: 0, requestId, action, state: 'applied', result: { readGrantId: `grant-${requestId}` } };
      return { status: 0, requestId, action, state: 'applied_unverified' };
    }
  };
  const service = (kind: string) => ({
    prepare: (...args: unknown[]) => { record(`${kind}.prepare`, args); return {}; },
    send: async (...args: unknown[]) => ({ status: 0, logId: '5001', requestId: args.find(a => typeof a === 'string' && a.includes('-')), state: 'sent_unverified' }),
    commit: async () => ({ status: 0, state: 'applied_unverified' })
  });
  const server = new McpStdioServer({ name: 'contract', version: '0', toolGroups: ['chats', 'friends'] });
  const policy = new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: `${os.tmpdir()}/kakao-max-web-contract-audit` });
  registerCoreReadTools(server, { kakao: kakao as never, policy, groups: ['chats', 'friends'], grants: () => undefined, engine: () => engine as never,
    config: { recipientDailyLimit: null, addFriendDailyLimit: 10, dataDir: os.tmpdir(), agentMode: 'trust', agentModeSource: 'setting', approval: { clientConfirm: false } } as never });
  registerAgentMessageTools(server, () => service('send') as never);
  registerAgentMutationTools(server, () => service('mutation') as never);
  registerAgentPublicationTools(server, () => service('publication') as never);
  registerNamedOperationTools(server, () => engine as never);
  registerChatTools(server, kakao as never);
  registerFriendsTools(server, kakao as never);
  if (opts.gate) server.setClientApproval(opts.gate as never);
  const listener = net.createServer(socket => server.serveConnection(socket, socket));
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const bridge = new McpBridge({ port: (listener.address() as net.AddressInfo).port });
  t.after(() => { bridge.close(); return new Promise<void>(resolve => listener.close(() => resolve())); });
  await bridge.connect();
  return { bridge, calls };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('every GUI read reaches an existing daemon tool with valid arguments', async t => {
  const { bridge, calls } = await daemon(t);
  assert.equal((await bridge.getStatus()).userId, ME);
  assert.equal((await bridge.listChats()).chats[0].id, OPEN);
  assert.equal((await bridge.getChatInfo(OPEN)).title, 'fixture room');
  assert.deepEqual((await bridge.getHistory(OPEN, 30, '4002')).messages.map(m => m.messageId), ['4001']);
  assert.deepEqual(calls.find(c => c.op === 'getHistory')?.args, { chatId: OPEN, opts: { max: '4002', cur: undefined, limit: 30 } });
  assert.equal((await bridge.searchMessages('hello', { chatId: OPEN, limit: 5 })).count, 1);
  assert.equal((await bridge.getUnreadSummary()).totalUnreadChats, 1);
  assert.equal((await bridge.listFriends('fixture', 10)).count, 1);
  assert.equal((await bridge.openDirectChat('fixture friend')).chatId, OPEN);
  assert.equal((await bridge.syncFriends()).totalFriends, 1);
  assert.equal((await bridge.downloadAttachment(OPEN, { messageId: '4001', token: 'k', isMini: true })).dataBase64, 'AQID');
  assert.deepEqual((await bridge.selfDeleteMessages(OPEN, ['4001'])).hidden, ['4001']);
});

test('every GUI write sends its own fresh requestId to an existing daemon tool', async t => {
  const { bridge, calls } = await daemon(t);
  const sent = await bridge.sendMessage(OPEN, 'fixture text', { reply: { logId: '4001', userId: FRIEND, text: 'fixture hello' } });
  assert.equal(sent.status, 0); assert.equal(sent.logId, '5001');
  assert.equal((await bridge.deleteMessage(OPEN, '4001')).status, 0);
  assert.equal((await bridge.forwardMessage(OPEN, { text: 'fixture text' })).status, 0);
  assert.equal((await bridge.markRead(OPEN, '4001')).status, 0);
  assert.equal((await bridge.leaveChat(OPEN, { silence: true })).status, 0);
  const ids = calls.filter(c => c.op.endsWith('.prepare') || c.op.startsWith('prepare:'))
    .map(c => Array.isArray(c.args) ? c.args.find(a => typeof a === 'string' && UUID.test(a)) : (c.args as { requestId: string }).requestId);
  assert.equal(ids.length, 5); assert.ok(ids.every(id => UUID.test(id)), 'each write carries a UUID requestId');
  assert.equal(new Set(ids).size, 5, 'a new requestId per action');
  assert.deepEqual(calls.filter(c => c.op.startsWith('prepare:')).map(c => c.op), ['prepare:mark_read', 'prepare:leave_chat']);
});

test('a room that needs approval surfaces APPROVAL_REQUIRED instead of contents', async t => {
  const { bridge } = await daemon(t);
  await assert.rejects(bridge.getHistory(DENIED), (e: { code?: string }) => e.code === 'APPROVAL_REQUIRED');
});

test('with no page to show it, the daemon dialog is cancelled at once and nothing is approved', async t => {
  const gate = fixtureGate();
  const { bridge } = await daemon(t, { gate });
  const started = Date.now();
  await assert.rejects(bridge.getHistory(DENIED), (e: { code?: string }) => e.code === 'APPROVAL_REQUIRED');
  assert.ok(Date.now() - started < 5000, 'no 120 s wait');
  assert.deepEqual(gate.answers, [{ action: 'cancel' }]); assert.equal(gate.approved, false);
});

test('the daemon dialog reaches the GUI as plain data, and only the typed code approves', async t => {
  const gate = fixtureGate();
  const { bridge } = await daemon(t, { gate });
  const seen: ApprovalDialog[] = [];
  bridge.on('approval', (d: ApprovalDialog) => {
    seen.push(d);
    // First a wrong code (the daemon asks again), then the right one.
    bridge.answerApproval(d.id, { action: 'accept', code: seen.length === 1 ? 'ZZZZ' : 'ABCD', remember: true });
  });
  await bridge.getHistory(DENIED).catch(() => undefined);
  assert.ok(seen.length >= 1, 'the dialog arrived');
  assert.match(seen[0].message, /<img src=x onerror=alert\(1\)>/, 'text is passed through untouched for plain-text display');
  assert.equal(seen[0].codeTitle, '확인 코드'); assert.equal(seen[0].rememberTitle, '이 방은 앞으로 묻지 않고 읽기');
  assert.deepEqual(gate.answers[0], { action: 'accept', content: { code: 'ZZZZ', remember: true } });
  assert.equal(bridge.pendingApprovalIds().length, 0);
});

test('declining in the GUI rejects the action', async t => {
  const gate = fixtureGate();
  const { bridge } = await daemon(t, { gate });
  bridge.on('approval', (d: ApprovalDialog) => bridge.answerApproval(d.id, { action: 'decline' }));
  await assert.rejects(bridge.getHistory(DENIED), (e: { code?: string }) => e.code === 'POLICY_DENIED');
  assert.equal(gate.approved, false);
});

test('approving in the GUI lets the action finish', async t => {
  const gate = fixtureGate();
  const { bridge } = await daemon(t, { gate });
  bridge.on('approval', (d: ApprovalDialog) => bridge.answerApproval(d.id, { action: 'accept', code: 'ABCD', remember: false }));
  const result = await bridge.getHistory(DENIED);
  assert.equal(gate.approved, true, 'the daemon recorded the approval');
  assert.deepEqual(gate.answers.at(-1), { action: 'accept', content: { code: 'ABCD', remember: false } });
  assert.deepEqual(result.messages.map(m => m.messageId), ['4001'], 'the approved read returns the room');
});
