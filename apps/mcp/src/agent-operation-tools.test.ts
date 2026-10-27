import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AgentSendJournal, DailyActionLimit, KakaoDb, RecipientPermissions, RoomAccessPolicy, SendPolicy, MCP_TOOL_GROUPS, agentModeApproves } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { checkToolGroups, loadOptionalModules, registerOptionalModules, type OptionalMcpModule } from './optional-modules.ts';
import { registerPermissionTools, registerNamedOperationTools, agentControlAdapter, grantViews, NAMED_OPERATION_TOOLS } from './tools/agent-operations.ts';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';

const CHAT = '123456789', MEMO = '222222222';

function harness(t: { after(fn: () => void): void }, opts: { cap?: string[]; groups?: boolean; friendLimit?: number; trust?: boolean; modules?: OptionalMcpModule[]; memoChat?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-op-tool-'));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), approvals = fixtureApprovals(journal, root);
  const rooms = new RoomAccessPolicy(db, Date.now, { isMemoChat: id => id === opts.memoChat }), effects: string[] = [];
  const policy = new SendPolicy({ ceiling: opts.cap ?? [CHAT], pausedAtStart: true, auditLogPath: path.join(root, 'audit') });
  const kakao = {
    selfUserId: '987654321',
    listChats: () => [{ id: CHAT, type: 'DirectChat', title: 'fixture 홍길동', memberCount: 2 }, { id: MEMO, type: 'MemoChat', title: 'fixture memo', memberCount: 1 }],
    getRoomAccess: (chatId: string) => ({ chatId, rule: rooms.rule(chatId), defaultMode: rooms.defaultRule(chatId).mode, unreadRestriction: 'confirmed-read-only' as const, readReceipts: 'separate-approval' as const }),
    restoreDefaultRoomAccess: (chatId: string) => ({ chatId, ...rooms.restoreDefault(chatId) }),
    resetRoomAccess: (chatId: string) => ({ chatId, rule: rooms.reset(chatId) }),
    defaultRoomAccess: (chatId: string) => rooms.defaultRule(chatId),
    setRoomAccess: (chatId: string, rule: unknown) => ({ chatId, rule: rooms.set(chatId, rule) }),
    tightenRoomAccess: (chatId: string, rule: unknown) => ({ chatId, rule: rooms.tighten(chatId, rule) }),
    listRoomAccess: () => rooms.listRules(),
    getFriend: (userId: string) => userId === '555555555' ? { userId, nickName: 'fixture 친구', type: 2 } : undefined,
    openDirectChat: async (userId: string, o: { allowCreate?: boolean; beforeCreate?: (u: string) => void }) => {
      if (!o.allowCreate) return { chatId: null, title: userId, isNew: false };
      o.beforeCreate?.(userId); effects.push(`create:${userId}`); return { chatId: '777777777', title: 'fixture', isNew: true };
    },
    leave: async (chatId: string, o: object) => { effects.push(`leave:${chatId}:${JSON.stringify(o)}`); return { status: 0 }; },
    setMeta: async () => { effects.push('meta'); return { status: 0 }; },
    markRead: async (chatId: string, watermark: string, confirm: boolean) => { effects.push(`read:${chatId}:${watermark}:${confirm}`); return { status: 0, readState: { confirmed: false, reason: 'server_unread', localUnreadCount: 31, serverUnreadCount: 31 } }; },
    blockUser: async (userId: string, blockType: number) => { effects.push(`block:${userId}:${blockType}`); return { status: 0 }; },
    unblockUser: async () => ({ status: 0 }), addFriend: async (userId: string) => { effects.push(`friend:${userId}`); return { status: 0 }; },
    createReadGrant: (g: Parameters<RoomAccessPolicy['createReadGrant']>[0]) => rooms.createReadGrant(g),
    listReadGrants: () => rooms.listReadGrants(), revokeReadGrant: (id: string) => rooms.revokeReadGrant(id)
  };
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'Asia/Seoul' });
  const friendAdds = new DailyActionLimit(journal.db, { action: 'add_friend', limit: opts.friendLimit ?? 10, timeZone: 'Asia/Seoul' });
  const modules = opts.modules ?? [];
  const engine = new AgentOperationEngine({ principal: 'local-mcp', journal, definitions: [...AGENT_CONTROL_DEFINITIONS, ...modules.flatMap(m => m.operations)], approvals: approvals.store,
    adapter: agentControlAdapter(kakao as never, policy, recipients, friendAdds, modules.map(m => ({ actions: m.operations.map(d => d.action), inspect: m.inspect }))),
    rateLimit: () => policy.describe().rateLimit,
    ...(opts.trust ? { modeApproves: (action: string) => agentModeApproves('trust', action) } : {}) });
  const server = new McpStdioServer({ name: 'test', version: '0', toolGroups: opts.groups === false ? [] : [...MCP_TOOL_GROUPS, ...modules.map(m => m.group)] });
  registerOptionalModules(server, modules, () => engine);
  registerPermissionTools(server, { engine: () => engine, grants: () => grantViews(kakao as never, recipients), policy });
  registerNamedOperationTools(server, () => engine);
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.end(); output.end(); journal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let id = 0, text = '';
  const pending = new Map<number, (value: any) => void>();
  output.on('data', chunk => {
    text += chunk.toString(); let n;
    while ((n = text.indexOf('\n')) >= 0) {
      const r = JSON.parse(text.slice(0, n)); text = text.slice(n + 1);
      pending.get(r.id)?.(r.result ?? { rpcError: r.error }); pending.delete(r.id);
    }
  });
  server.serveConnection(input, output);
  const call = (name: string, args: Record<string, unknown>) => new Promise<any>(resolve => {
    const next = ++id; pending.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const result = (r: any) => { assert.equal(r.isError, false, JSON.stringify(r.structuredContent)); return JSON.parse(r.content[0].text); };
  const code = (r: any) => r.structuredContent?.error?.code;
  /** First call of a write: nothing happens yet and the exact approval text comes back. */
  const ask = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    assert.equal(code(r), 'APPROVAL_REQUIRED', `${name}: ${JSON.stringify(r.structuredContent)}`);
    return r.structuredContent.error.details.approval as { requestId: string; signingText: string };
  };
  /** Ask, record the person's approval as the client dialog would, and return the approval text. */
  const approve = async (name: string, args: Record<string, unknown>) => { const a = await ask(name, args); approvals.approve(a); return a; };
  return { call, result, code, ask, approve, rooms, policy, effects, recipients, friendAdds };
}

test('the agent can pause at once but releasing the pause needs the person, with a stable requestId', async t => {
  const h = harness(t);
  assert.equal(h.code(await h.call('pause', { paused: false })), 'INVALID_ARGUMENT'); assert.equal(h.policy.isPaused(), true);
  const requestId = randomUUID();
  const approval = await h.approve('pause', { paused: false, requestId });
  assert.equal(JSON.parse(approval.signingText).context.ceiling[0], CHAT); assert.equal(h.policy.isPaused(), true);
  assert.deepEqual(h.result(await h.call('pause', { paused: false, requestId })), { paused: false });
  assert.equal(h.result(await h.call('get_operation', { requestId })).state, 'applied');
  assert.deepEqual(h.result(await h.call('pause', { paused: true })), { paused: true });
  h.policy.setPaused(false);
  assert.deepEqual(h.result(await h.call('pause', { paused: false, requestId: randomUUID() })), { paused: false });
});

test('room read access widens only with approval, lists as room:<chatId> and narrows back to deny immediately', async t => {
  const h = harness(t), requestId = randomUUID(), args = { requestId, chatId: CHAT, type: 'room_access', rule: { mode: 'manual', maxMessages: 5 } };
  const approval = await h.ask('request_permission', args);
  assert.deepEqual(JSON.parse(approval.signingText).context.room, { title: 'fixture 홍길동', type: 'DirectChat', memberCount: 2 });
  assert.equal(h.rooms.rule(CHAT).mode, 'deny');
  await h.approve('request_permission', args);
  assert.equal(h.code(await h.call('request_permission', { ...args, rule: { mode: 'immediate' } })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.result(await h.call('request_permission', args)).state, 'applied');
  assert.deepEqual(h.rooms.rule(CHAT), { mode: 'manual', maxMessages: 5 });
  const listed = h.result(await h.call('list_permissions', {}));
  assert.equal(listed.readRooms[0].permissionId, `room:${CHAT}`); assert.equal(listed.untrusted, true);
  assert.equal(h.result(await h.call('revoke_permission', { permissionId: `room:${CHAT}` })).revoked, true);
  assert.equal(h.rooms.rule(CHAT).mode, 'deny');
  assert.equal(h.result(await h.call('revoke_permission', { permissionId: `room:${CHAT}` })).revoked, false);
  for (const bad of [{ ...args, requestId: randomUUID(), type: 'everything' }, { ...args, requestId: randomUUID(), type: 'send' }, { ...args, requestId: randomUUID(), rule: { mode: 'deny' } }]) {
    assert.equal(h.code(await h.call('request_permission', bad)), 'INVALID_ARGUMENT', JSON.stringify(bad));
  }
});

test('room_default narrows at once, but a broader default (memo chat) waits for the person and shows both rules', async t => {
  const h = harness(t, { memoChat: MEMO });
  h.rooms.set(CHAT, { mode: 'immediate' });
  assert.deepEqual(h.result(await h.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'room_default' })),
    { status: 0, chatId: CHAT, rule: { mode: 'deny' }, changed: true });
  assert.equal(h.rooms.hasStoredRule(CHAT), false);
  assert.equal(h.result(await h.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'room_default' })).changed, false);
  h.rooms.set(MEMO, { mode: 'manual' });
  const args = { requestId: randomUUID(), chatId: MEMO, type: 'room_default' };
  const approval = await h.ask('request_permission', args);
  const envelope = JSON.parse(approval.signingText);
  assert.equal(envelope.action, 'reset_room_access');
  assert.deepEqual([envelope.context.previous, envelope.context.next], [{ mode: 'manual' }, { mode: 'immediate' }]);
  assert.deepEqual(envelope.context.room, { title: 'fixture memo', type: 'MemoChat', memberCount: 1 });
  assert.equal(h.rooms.hasStoredRule(MEMO), true, 'nothing changes before approval');
  await h.approve('request_permission', args);
  assert.equal(h.result(await h.call('request_permission', args)).state, 'applied');
  assert.equal(h.rooms.hasStoredRule(MEMO), false); assert.deepEqual(h.rooms.rule(MEMO), { mode: 'immediate' });
  assert.equal(h.code(await h.call('request_permission', { ...args, requestId: randomUUID(), rule: { mode: 'immediate' } })), 'INVALID_ARGUMENT');
});

test('named operation tools refuse unapproved calls and commit only the exact approved request', async t => {
  const h = harness(t); h.policy.setPaused(false);
  const named: Array<[string, Record<string, unknown>]> = [['leave_chat', { chatId: CHAT }], ['set_chat_meta', { chatId: CHAT, type: 1, content: '{}' }],
    ['mark_read', { chatId: CHAT, watermark: '9007199254740993' }], ['create_direct_chat', { userId: '555555555' }], ['block_user', { userId: '555555555' }],
    ['unblock_user', { userId: '555555555' }], ['add_friend', { userId: '555555555' }]];
  assert.deepEqual(named.map(n => n[0]).sort(), [...NAMED_OPERATION_TOOLS].sort());
  for (const [name, args] of named) {
    await h.ask(name, { ...args, requestId: randomUUID() });
    assert.equal(h.code(await h.call(name, { ...args, requestId: randomUUID(), confirm: true })), 'INVALID_ARGUMENT', name);
    assert.equal(h.code(await h.call(name, args)), 'INVALID_ARGUMENT', `${name} without requestId`);
  }
  assert.deepEqual(h.effects, []);

  const leave = { chatId: CHAT, silence: true, requestId: randomUUID() };
  const reviewed = await h.approve('leave_chat', leave);
  assert.deepEqual(JSON.parse(reviewed.signingText).request, { block: false, chatId: CHAT, silence: true });
  assert.equal(h.code(await h.call('leave_chat', { ...leave, block: true })), 'IDEMPOTENCY_CONFLICT');
  const left = h.result(await h.call('leave_chat', leave));
  assert.equal(left.state, 'applied_unverified'); assert.equal(left.untrusted, true);
  assert.deepEqual(h.effects, [`leave:${CHAT}:{"silence":true,"block":false}`]);

  const read = { chatId: CHAT, watermark: '9007199254740993', requestId: randomUUID() };
  await h.approve('mark_read', read);
  const readResult = h.result(await h.call('mark_read', read));
  assert.equal(readResult.result.readState.confirmed, false); assert.equal(readResult.result.readState.serverUnreadCount, 31);
  assert.equal(h.effects.at(-1), `read:${CHAT}:9007199254740993:true`);

  const create = { userId: '555555555', requestId: randomUUID() };
  assert.deepEqual(JSON.parse((await h.approve('create_direct_chat', create)).signingText).context.friend, { known: true, nickname: 'fixture 친구', type: 2 });
  assert.deepEqual(h.result(await h.call('create_direct_chat', create)).result, { chatId: '777777777', isNew: true });
});

test('optional groups are not listed or callable unless enabled', async t => {
  const h = harness(t, { groups: false });
  for (const name of NAMED_OPERATION_TOOLS) assert.equal((await h.call(name, { requestId: randomUUID() })).rpcError.code, -32602, name);
  await h.ask('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'send' });
});

test('account actions stay blocked while paused', async t => {
  const h = harness(t);
  assert.equal(h.code(await h.call('block_user', { userId: '555555555', requestId: randomUUID() })), 'POLICY_DENIED');
  h.policy.setPaused(false);
  const block = { userId: '555555555', blockType: 2, requestId: randomUUID() };
  await h.approve('block_user', block);
  h.policy.setPaused(true);
  assert.equal(h.code(await h.call('block_user', block)), 'POLICY_DENIED'); assert.deepEqual(h.effects, []);
});

test('an optional module adds its own approved operation, label and group, and its absence leaves nothing behind', async t => {
  const effects: string[] = [];
  const fixture: OptionalMcpModule = { group: 'fixture', registerTools: () => {}, labels: { import_fixture: '시험 가져오기' }, readGrantTools: [],
    operations: [{ action: 'import_fixture', effect: 'local', parseRequest: input => input as Record<string, unknown>,
      parseContext: (_request, context) => context, scope: request => (request as { chatId: string }).chatId }],
    namedOperations: [{ name: 'import_fixture', group: 'fixture', destructive: false, summary: 'Fixture import.', fields: { chatId: { type: 'string' } }, required: ['chatId'] }],
    inspect: async (_action, raw) => ({ context: { kind: 'fixture' }, validate: () => {},
      execute: async () => { effects.push(JSON.stringify(raw)); return { status: 0 }; } }) };
  const h = harness(t, { modules: [fixture] }); h.policy.setPaused(false);
  const request = { chatId: CHAT, requestId: randomUUID() };
  const asked = await h.approve('import_fixture', request);
  assert.equal(JSON.parse(asked.signingText).action, 'import_fixture');
  assert.equal(h.result(await h.call('import_fixture', request)).state, 'applied');
  assert.deepEqual(effects, [JSON.stringify({ chatId: CHAT })]);
  assert.throws(() => checkToolGroups(['fixture'], MCP_TOOL_GROUPS, []), { code: 'CONFIG_INVALID' });
  checkToolGroups(['fixture', 'chats'], MCP_TOOL_GROUPS, [fixture]);
  assert.deepEqual(await loadOptionalModules({} as never, ['@kakao-max/not-installed-fixture/mcp']), []);
  const without = harness(t);
  assert.equal((await without.call('import_fixture', request)).rpcError.code, -32602);
});

test('read grants are narrow by default, list without contents and revoke immediately', async t => {
  const h = harness(t);
  // A default-deny room asks for a one-time grant; an open room needs none.
  assert.equal(h.code(await h.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'read' })), 'APPROVAL_REQUIRED');
  h.rooms.set(CHAT, { mode: 'immediate' });
  assert.equal(h.code(await h.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'read' })), 'INVALID_ARGUMENT');
  h.rooms.set(CHAT, { mode: 'manual', maxMessages: 30 }); // operator-side fixture rule
  const narrow = await h.ask('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'read' });
  assert.deepEqual(JSON.parse(narrow.signingText).request, { chatId: CHAT, maxMessages: 20, tools: ['read_messages'], ttlMinutes: 10, uses: 1 });
  const readArgs = { requestId: randomUUID(), chatId: CHAT, type: 'read', tools: ['read_messages'], maxMessages: 5, uses: 2 };
  assert.deepEqual(JSON.parse((await h.approve('request_permission', readArgs)).signingText).context.rule, { maxMessages: 30, mode: 'manual' });
  const created = h.result(await h.call('request_permission', readArgs)).result;
  assert.equal(created.uses, 2);
  h.rooms.take(CHAT, { readGrant: { id: created.readGrantId, tool: 'read_messages' } }, 5);
  assert.equal(h.code(await h.call('request_permission', { ...readArgs, requestId: randomUUID(), tools: ['get_history'] })), 'INVALID_ARGUMENT');

  assert.equal(h.code(await h.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'standing', texts: ['fixture'], label: 'fixture' })), 'INVALID_ARGUMENT');
  const listed = h.result(await h.call('list_permissions', {}));
  assert.equal(listed.readGrants[0].usesLeft, 1); assert.equal(listed.standingGrants, undefined);
  assert.equal(h.result(await h.call('revoke_permission', { permissionId: created.readGrantId })).revoked, true);
  assert.equal(h.result(await h.call('list_permissions', {})).readGrants.length, 0);
  assert.throws(() => h.rooms.take(CHAT, { readGrant: { id: created.readGrantId, tool: 'read_messages' } }, 1), { code: 'POLICY_DENIED' });
});

test('a send permission needs approval, lists and revokes as recipient:<chatId>, never touches content access, and cannot cross the ceiling', async t => {
  const denied = harness(t, { cap: ['987654321'] }); denied.policy.setPaused(false);
  assert.equal(denied.code(await denied.call('request_permission', { requestId: randomUUID(), chatId: CHAT, type: 'send' })), 'POLICY_DENIED');
  assert.equal(denied.recipients.list().length, 0);
  const h = harness(t, { cap: [] }); h.policy.setPaused(false);
  const args = { requestId: randomUUID(), chatId: CHAT, type: 'send' };
  assert.deepEqual(JSON.parse((await h.ask('request_permission', args)).signingText).context.room, { title: 'fixture 홍길동', type: 'DirectChat', memberCount: 2 });
  assert.equal(h.recipients.list().length, 0);
  await h.approve('request_permission', args);
  assert.equal(h.result(await h.call('request_permission', args)).result.grantId, `recipient:${CHAT}`);
  assert.equal(h.result(await h.call('list_permissions', {})).sendRooms[0].chatId, CHAT);
  assert.deepEqual(h.policy.describe().ceiling, []); assert.equal(h.rooms.rule(CHAT).mode, 'deny'); assert.deepEqual(h.effects, []);
  assert.equal(h.result(await h.call('revoke_permission', { permissionId: `recipient:${CHAT}` })).revoked, true);
  assert.equal(h.result(await h.call('list_permissions', {})).sendRooms.length, 0);
});

test('add_friend stops at the daily cap before asking anyone, and an approval taken under the cap cannot exceed it', async t => {
  const h = harness(t, { friendLimit: 2 }); h.policy.setPaused(false);
  for (const userId of ['555555555', '555555556']) {
    const add = { userId, requestId: randomUUID() };
    await h.approve('add_friend', add);
    assert.equal(h.result(await h.call('add_friend', add)).state, 'applied_unverified');
  }
  assert.deepEqual(h.effects, ['friend:555555555', 'friend:555555556']);
  const over = await h.call('add_friend', { userId: '555555557', requestId: randomUUID() });
  assert.equal(h.code(over), 'RATE_LIMITED', 'refused before an approval is requested');
  assert.equal(over.structuredContent.error.retryable, false);
  assert.deepEqual(over.structuredContent.error.details, { action: 'add_friend', limit: 2, usedToday: 2 });
  assert.equal(h.friendAdds.usedToday(), 2); assert.equal(h.effects.length, 2);
});

test('two add_friend approvals taken at once under a cap of one apply only one', async t => {
  const h = harness(t, { friendLimit: 1 }); h.policy.setPaused(false);
  const first = { userId: '555555555', requestId: randomUUID() }, second = { userId: '555555556', requestId: randomUUID() };
  await h.approve('add_friend', first); await h.approve('add_friend', second);
  h.result(await h.call('add_friend', first));
  assert.equal(h.code(await h.call('add_friend', second)), 'RATE_LIMITED');
  assert.deepEqual(h.effects, ['friend:555555555']);
});

test('trust mode adds friends without asking but still stops at the daily cap', async t => {
  const h = harness(t, { friendLimit: 1, trust: true }); h.policy.setPaused(false);
  assert.equal(h.result(await h.call('add_friend', { userId: '555555555', requestId: randomUUID() })).state, 'applied_unverified');
  assert.equal(h.code(await h.call('add_friend', { userId: '555555556', requestId: randomUUID() })), 'RATE_LIMITED');
  assert.deepEqual(h.effects, ['friend:555555555']);
});
