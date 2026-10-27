import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, agentOperationDefinition, type AgentOperationDefinition, type GrantRoomAccessRequest } from './agent-operation.ts';
import { AgentSendJournal } from './agent-send.ts';
import { KakaoDb } from './db.ts';
import { RoomAccessPolicy, isRoomAccessTightening, type RoomAccessRule } from './room-access.ts';

const CHAT = '123456789';
const grant = (rule: RoomAccessRule): GrantRoomAccessRequest => ({ chatId: CHAT, rule });
// A remote fixture definition proves the engine's provider path without any real action.
const remote: AgentOperationDefinition<{ chatId: string }, { kind: 'fixture' }> = {
  action: 'fixture_remote', effect: 'remote',
  parseRequest: input => { assert.deepEqual(Object.keys(input as object), ['chatId']); return { chatId: (input as { chatId: string }).chatId }; },
  parseContext: (_r, input) => { assert.deepEqual(input, { kind: 'fixture' }); return { kind: 'fixture' }; },
  scope: r => `room:${r.chatId}`
};

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-operation-'));
  const db = KakaoDb.open({ dir: root }), journals: AgentSendJournal[] = [];
  let now = Date.parse('2026-10-24T00:00:00Z'), executions = 0, fail = false;
  const rooms = new RoomAccessPolicy(db, () => now);
  const adapter = {
    accountId: () => '123456789',
    inspect: async (action: string, raw: unknown) => {
      if (action === 'fixture_remote') return { context: { kind: 'fixture' }, validate: () => {}, execute: async () => { executions++; return { status: 0 }; } };
      const request = raw as GrantRoomAccessRequest;
      return { context: { kind: 'room-access', chatId: request.chatId, previous: rooms.rule(request.chatId), room: { title: 'fixture room', type: 'DirectChat', memberCount: 2 } },
        validate: () => {},
        execute: async () => { executions++; if (fail) throw new Error('fixture storage failure'); rooms.set(request.chatId, request.rule); return { status: 0 }; } };
    }
  };
  const create = () => {
    const journal = AgentSendJournal.open(root); journals.push(journal);
    const approvals = fixtureApprovals(journal, root, () => now);
    return { journal, approve: approvals.approve, engine: new AgentOperationEngine({ principal: 'local-mcp', journal, adapter, definitions: [...AGENT_CONTROL_DEFINITIONS, remote],
      approvals: approvals.store, rateLimit: () => ({ windowMs: 60000, perChat: 1, global: 10 }), now: () => now }) };
  };
  t.after(() => { for (const j of journals) j.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...create(), create, rooms, db,
    executions: () => executions, fail: () => { fail = true; }, advance: (ms: number) => { now += ms; } };
}

test('narrowing is recognized only when nothing broader is granted', () => {
  const manual: RoomAccessRule = { mode: 'manual', maxMessages: 10, expiresAt: '2026-10-25T00:00:00Z' };
  assert.equal(isRoomAccessTightening(manual, { mode: 'deny' }), true);
  assert.equal(isRoomAccessTightening({ mode: 'immediate' }, { mode: 'deny', expiresAt: '2026-10-25T00:00:00Z' }), true);
  assert.equal(isRoomAccessTightening(manual, { mode: 'manual', maxMessages: 5, expiresAt: '2026-10-24T12:00:00Z' }), true);
  assert.equal(isRoomAccessTightening({ mode: 'manual' }, { mode: 'manual', maxMessages: 50, callsPerHour: 60 }), true);
  for (const broader of [
    { mode: 'manual', maxMessages: 11, expiresAt: '2026-10-25T00:00:00Z' },
    { mode: 'manual', maxMessages: 10 }, // removed expiry
    { mode: 'manual', maxMessages: 10, expiresAt: '2026-10-26T00:00:00Z' },
    { mode: 'manual', maxMessages: 10, expiresAt: '2026-10-25T00:00:00Z', callsPerHour: 61 },
    { mode: 'immediate', maxMessages: 1, expiresAt: '2026-10-24T01:00:00Z' },
    { mode: 'manual', maxMessages: 10, expiresAt: '2026-10-25T00:00:00Z', unreadPreviewAfterLogId: '9007199254740993' }
  ] as RoomAccessRule[]) assert.equal(isRoomAccessTightening(manual, broader), false, JSON.stringify(broader));
  assert.equal(isRoomAccessTightening({ mode: 'deny' }, { mode: 'manual', maxMessages: 1 }), false);
  const daily = { timeZone: 'Asia/Seoul', times: ['18:00'], windowMinutes: 10 };
  assert.equal(isRoomAccessTightening({ mode: 'scheduled', schedule: daily }, { mode: 'scheduled', schedule: { windowMinutes: 10, times: ['18:00'], timeZone: 'Asia/Seoul' } }), true);
  assert.equal(isRoomAccessTightening({ mode: 'scheduled', schedule: daily }, { mode: 'scheduled', schedule: { ...daily, times: ['19:00'] } }), false);
});

test('RoomAccessPolicy.tighten applies narrowing and refuses broadening against the effective rule', t => {
  const f = fixture(t);
  assert.throws(() => f.rooms.tighten(CHAT, { mode: 'manual' }), { code: 'APPROVAL_REQUIRED' });
  f.rooms.set(CHAT, { mode: 'immediate', expiresAt: '2026-10-24T01:00:00Z' });
  assert.deepEqual(f.rooms.tighten(CHAT, { mode: 'immediate', maxMessages: 3, expiresAt: '2026-10-24T00:30:00Z' }).maxMessages, 3);
  f.advance(3600_000); // the stored rule expired; its effective rule is deny, so re-enabling is broadening
  assert.throws(() => f.rooms.tighten(CHAT, { mode: 'immediate', maxMessages: 3, expiresAt: '2026-10-24T02:00:00Z' }), { code: 'APPROVAL_REQUIRED' });
});

test('grant_room_access needs human approval, applies once, and replays only its outcome after restart', async t => {
  const f = fixture(t), id = randomUUID(), request = grant({ mode: 'manual', maxMessages: 5 });
  const prepared = await f.engine.prepare('grant_room_access', id, request);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.approvalRequired, true); assert.equal(f.rooms.rule(CHAT).mode, 'deny');
  const envelope = JSON.parse(prepared.signingText!);
  assert.equal(envelope.domain, 'agent-op-v1:grant_room_access'); assert.deepEqual(envelope.context.previous, { mode: 'deny' });
  await assert.rejects(f.engine.commit('grant_room_access', id, request), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.executions(), 0); assert.equal(f.rooms.rule(CHAT).mode, 'deny');
  f.approve(prepared);
  const out = await f.engine.commit('grant_room_access', id, request);
  assert.deepEqual(out, { status: 0, requestId: id, action: 'grant_room_access', state: 'applied' });
  assert.deepEqual(f.rooms.rule(CHAT), { mode: 'manual', maxMessages: 5 });
  // A local fence never consumes the durable send attempt budget.
  assert.equal(f.journal.get(id)?.attempted_at, null);
  const restarted = f.create().engine;
  assert.equal((await restarted.commit('grant_room_access', id, request)).state, 'applied');
  assert.equal(restarted.status(id).state, 'applied'); assert.equal(f.executions(), 1);
  await assert.rejects(restarted.prepare('grant_room_access', id, grant({ mode: 'immediate' })), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(restarted.prepare('resume_sending', id, {}), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('a changed previous rule or expiry makes the approval unusable without applying anything', async t => {
  const f = fixture(t), stale = randomUUID(), late = randomUUID(), request = grant({ mode: 'immediate' });
  const p1 = await f.engine.prepare('grant_room_access', stale, request); f.approve(p1);
  f.rooms.set(CHAT, { mode: 'manual' }); // operator changed the room after review
  await assert.rejects(f.engine.commit('grant_room_access', stale, request), { code: 'OPERATION_STALE' });
  assert.equal((await f.engine.prepare('grant_room_access', stale, request)).state, 'stale');
  const p2 = await f.engine.prepare('grant_room_access', late, request); f.approve(p2);
  f.advance(300_000);
  await assert.rejects(f.engine.commit('grant_room_access', late, request), { code: 'OPERATION_EXPIRED' });
  assert.equal(f.executions(), 0); assert.deepEqual(f.rooms.rule(CHAT), { mode: 'manual' });
});

test('a failure after the fence stays unknown and is never executed again', async t => {
  const f = fixture(t), id = randomUUID(), request = grant({ mode: 'manual' });
  const prepared = await f.engine.prepare('grant_room_access', id, request); f.approve(prepared);
  f.fail();
  await assert.rejects(f.engine.commit('grant_room_access', id, request), { code: 'MUTATION_OUTCOME_UNKNOWN' });
  assert.equal(f.journal.get(id)?.state, 'mutation_unknown');
  await assert.rejects(f.create().engine.commit('grant_room_access', id, request), { code: 'MUTATION_OUTCOME_UNKNOWN' });
  assert.equal(f.create().engine.status(id).state, 'mutation_unknown'); assert.equal(f.executions(), 1);
});

test('remote effects claim the durable attempt budget and acknowledge as unverified', async t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  const p1 = await f.engine.prepare('fixture_remote', first, { chatId: CHAT }); f.approve(p1);
  assert.equal((await f.engine.commit('fixture_remote', first, { chatId: CHAT })).state, 'applied_unverified');
  assert.notEqual(f.journal.get(first)?.attempted_at, null);
  const p2 = await f.engine.prepare('fixture_remote', second, { chatId: CHAT }); f.approve(p2);
  await assert.rejects(f.engine.commit('fixture_remote', second, { chatId: CHAT }), { code: 'RATE_LIMITED' });
  assert.equal(f.executions(), 1);
});

test('control requests and contexts are closed, exact and bounded', () => {
  const grantDef = agentOperationDefinition('grant_room_access'), resume = agentOperationDefinition('resume_sending');
  assert.throws(() => agentOperationDefinition('delete_account'), { code: 'INVALID_ARGUMENT' });
  for (const bad of [{ chatId: 123456789, rule: { mode: 'manual' } }, { chatId: CHAT, rule: { mode: 'manual' }, confirm: true },
    { chatId: CHAT, rule: { mode: 'everything' } }, { chatId: '0', rule: { mode: 'manual' } }]) assert.throws(() => grantDef.parseRequest(bad), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resume.parseRequest({ paused: false }), { code: 'INVALID_ARGUMENT' });
  const context = { kind: 'pause', paused: true, notifyChatId: null, ceiling: ['123456789', '987654321'], rateLimit: { windowMs: 60000, perChat: 5, global: 20 } };
  assert.deepEqual(resume.parseContext({}, context), context);
  for (const bad of [{ ...context, ceiling: ['987654321', '123456789'] }, { ...context, ceiling: ['*'] }, { ...context, paused: false }, { ...context, raw: {} }, { ...context, ceiling: ['room'] }])
    assert.throws(() => resume.parseContext({}, bad), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => grantDef.parseContext(grant({ mode: 'manual' }), { kind: 'room-access', chatId: '987654321', previous: { mode: 'deny' }, room: { title: null, type: null, memberCount: null } }), { code: 'INVALID_ARGUMENT' });
});

test('account requests normalize optional defaults into the signed request and reject loose input', () => {
  const def = (a: string) => agentOperationDefinition(a);
  assert.deepEqual(def('leave_chat').parseRequest({ chatId: CHAT }), { block: false, chatId: CHAT, silence: false });
  assert.deepEqual(def('leave_chat').parseRequest({ chatId: CHAT, silence: undefined }), { block: false, chatId: CHAT, silence: false });
  assert.deepEqual(def('block_user').parseRequest({ userId: CHAT }), { blockType: 1, userId: CHAT });
  for (const [action, bad] of [
    ['leave_chat', { chatId: CHAT, confirm: true }], ['leave_chat', { chatId: CHAT, silence: 'yes' }],
    ['set_chat_meta', { chatId: CHAT, type: 0, content: '' }], ['set_chat_meta', { chatId: CHAT, type: 1, content: 'x'.repeat(16385) }],
    ['mark_read', { chatId: CHAT, watermark: 9007199254740993 }], ['create_direct_chat', { userId: 'name' }],
    ['block_user', { userId: CHAT, blockType: 3 }], ['add_friend', { userId: CHAT, confirm: true }]
  ] as const) assert.throws(() => def(action).parseRequest(bad), { code: 'INVALID_ARGUMENT' }, `${action} ${JSON.stringify(bad)}`);
  // Review contexts carry only bounded metadata: no message or notice contents.
  const meta = def('set_chat_meta'), request = meta.parseRequest({ chatId: CHAT, type: 1, content: '{}' });
  assert.throws(() => meta.parseContext(request, { kind: 'room', chatId: CHAT, room: { title: null, type: null, memberCount: null, notice: 'x' } }), { code: 'INVALID_ARGUMENT' });
});
