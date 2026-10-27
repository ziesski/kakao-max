import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApprovalStore, ApproverRegistry, approvalChallenge, verifyWebAuthnAssertion, verifyWebAuthnRegistration, type WebAuthnApprover } from './approvals.ts';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS } from './agent-operation.ts';
import { AgentSendJournal, AgentSendService } from './agent-send.ts';
import { KakaoDb } from './db.ts';
import { RoomAccessPolicy } from './room-access.ts';
import { SendPolicy } from './policy.ts';
import { fixtureAuthenticator } from './webauthn-fixture.test-helper.ts';

const ORIGIN = 'https://approve.example.test';

function enrolled(alg: -7 | -8 = -7) {
  const device = fixtureAuthenticator(alg), challenge = randomBytes(32);
  const approver = verifyWebAuthnRegistration(device.register(challenge, ORIGIN), challenge, ORIGIN, 'fixture phone', 1000);
  return { device, approver };
}

test('registration binds the operator challenge, origin, user verification and the attested credential ID', () => {
  const device = fixtureAuthenticator(), challenge = randomBytes(32);
  const approver = verifyWebAuthnRegistration(device.register(challenge, ORIGIN), challenge, ORIGIN, 'fixture phone');
  assert.equal(approver.rpId, 'approve.example.test'); assert.equal(approver.id, device.credentialId);
  for (const [registration, c, o] of [
    [device.register(challenge, ORIGIN), randomBytes(32), ORIGIN],
    [device.register(challenge, 'https://evil.example.test'), challenge, ORIGIN],
    [device.register(challenge, ORIGIN, { flags: 0x41 }), challenge, ORIGIN], // no UV
    [{ ...device.register(challenge, ORIGIN), credentialId: randomBytes(16).toString('base64url') }, challenge, ORIGIN],
    [{ ...device.register(challenge, ORIGIN), alg: -36 }, challenge, ORIGIN],
    [{ ...device.register(challenge, ORIGIN), alg: -8 }, challenge, ORIGIN] // key type does not match algorithm
  ] as const) assert.throws(() => verifyWebAuthnRegistration(registration as never, c as Buffer, o, 'fixture'), { code: 'APPROVAL_REQUIRED' });
  assert.throws(() => verifyWebAuthnRegistration(device.register(challenge, ORIGIN), challenge, ORIGIN, 'bad\nlabel'), { code: 'INVALID_ARGUMENT' });
});

test('assertions verify only the exact challenge with user verification from a registered, advancing credential', () => {
  for (const alg of [-7, -8] as const) {
    const { device, approver } = enrolled(alg), challenge = approvalChallenge('{"fixture":true}');
    const count = verifyWebAuthnAssertion(approver, challenge, device.assert(challenge, ORIGIN));
    const next: WebAuthnApprover = { ...approver, signCount: count };
    assert.throws(() => verifyWebAuthnAssertion(next, challenge, device.assert(challenge, ORIGIN, { counter: count })), { code: 'APPROVAL_REQUIRED' });
    for (const bad of [
      device.assert(approvalChallenge('{"fixture":false}'), ORIGIN), device.assert(challenge, 'https://evil.example.test'),
      device.assert(challenge, ORIGIN, { flags: 0x01 }), device.assert(challenge, ORIGIN, { type: 'webauthn.create' }),
      device.assert(challenge, ORIGIN, { rpId: 'example.test' }),
      { ...device.assert(challenge, ORIGIN), signature: fixtureAuthenticator(alg).assert(challenge, ORIGIN).signature },
      { ...device.assert(challenge, ORIGIN), credentialId: randomBytes(16).toString('base64url') }
    ]) assert.throws(() => verifyWebAuthnAssertion(next, challenge, bad), { code: 'APPROVAL_REQUIRED' });
  }
});

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), registry = new ApproverRegistry(root);
  let now = 1_000_000;
  const store = new ApprovalStore(journal, registry, () => now), rooms = new RoomAccessPolicy(db);
  const engine = new AgentOperationEngine({ principal: 'local-mcp', journal, approvals: store, definitions: AGENT_CONTROL_DEFINITIONS, now: () => now,
    rateLimit: () => ({ windowMs: 60000, perChat: 5, global: 20 }),
    adapter: { accountId: () => '123456789', inspect: async (_a, raw) => {
      const r = raw as { chatId: string; rule: { mode: 'manual' } };
      return { context: { kind: 'room-access', chatId: r.chatId, previous: rooms.rule(r.chatId), room: { title: null, type: null, memberCount: null } },
        validate: () => {}, execute: async () => { rooms.set(r.chatId, r.rule); return { status: 0 }; } };
    } } });
  t.after(() => { journal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, journal, registry, store, engine, rooms, now: () => now, advance: (ms: number) => { now += ms; } };
}

test('a stored passkey approval authorizes exactly its envelope until the approver is removed', async t => {
  const f = fixture(t), { device, approver } = enrolled(), id = randomUUID(), request = { chatId: '123456789', rule: { mode: 'manual' } };
  assert.equal(f.store.configured(), false);
  f.registry.add(approver);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.registry.file).mode & 0o777, 0o600); assert.equal(f.store.configured(), true);
  const prepared = await f.engine.prepare('grant_room_access', id, request);
  assert.equal(prepared.approvalConfigured, true); assert.equal(f.store.state(id), 'awaiting_approval');
  await assert.rejects(f.engine.commit('grant_room_access', id, request), { code: 'APPROVAL_REQUIRED' });
  assert.throws(() => f.store.approve(id, prepared.signingText!, device.assert(approvalChallenge(prepared.signingText! + ' '), ORIGIN)), { code: 'APPROVAL_REQUIRED' });
  f.store.approve(id, prepared.signingText!, device.assert(approvalChallenge(prepared.signingText!), ORIGIN));
  assert.equal(f.store.state(id), 'approved'); assert.equal(f.registry.get(approver.id)!.signCount > 0, true);
  // The DB keeps only an HMAC: no draft text, assertion or signature.
  const stored = f.journal.db.db.prepare('SELECT * FROM agent_approvals').all() as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(stored[0]).sort(), ['approver_id', 'envelope_digest', 'request_id', 'verified_at']);
  assert.equal(JSON.stringify(stored).includes('manual'), false);
  f.registry.remove(approver.id);
  await assert.rejects(f.engine.commit('grant_room_access', id, request), { code: 'APPROVAL_REQUIRED' });
  f.registry.add({ ...approver, signCount: 99 });
  assert.equal((await f.engine.commit('grant_room_access', id, request)).state, 'applied');
  assert.equal(f.store.state(id), 'applied'); assert.equal(f.rooms.rule('123456789').mode, 'manual');
});

test('rejection is terminal for every service, and only prepared, unexpired rows can be approved', async t => {
  const f = fixture(t), { device, approver } = enrolled(); f.registry.add(approver);
  const rejected = randomUUID(), request = { chatId: '123456789', rule: { mode: 'manual' } };
  const p = await f.engine.prepare('grant_room_access', rejected, request);
  f.store.reject(rejected);
  assert.equal(f.store.state(rejected), 'rejected');
  assert.throws(() => f.store.approve(rejected, p.signingText!, device.assert(approvalChallenge(p.signingText!), ORIGIN)), { code: 'APPROVAL_REQUIRED' });
  await assert.rejects(f.engine.commit('grant_room_access', rejected, request), { code: 'POLICY_DENIED' });
  assert.throws(() => f.store.reject(rejected), { code: 'INVALID_ARGUMENT' });
  const late = randomUUID(), q = await f.engine.prepare('grant_room_access', late, request);
  f.advance(300_000); assert.equal(f.store.state(late), 'expired');
  assert.throws(() => f.store.approve(late, q.signingText!, device.assert(approvalChallenge(q.signingText!), ORIGIN)), { code: 'OPERATION_EXPIRED' });

  // Text sends honour stored approvals and rejections through the same interface.
  let sends = 0;
  const service = new AgentSendService({ principal: 'local-mcp', journal: f.journal, approvals: f.store, now: f.now,
    policy: new SendPolicy({ ceiling: ['123456789'], pausedAtStart: false, auditLogPath: path.join(f.root, 'audit') }),
    adapter: { accountId: () => '123456789', connected: () => true, context: () => 'fixture', send: async () => { sends++; return { status: 0, logId: '9007199254740993' }; } } });
  const message = { chatId: '123456789', text: 'fixture draft' }, approved = randomUUID(), refused = randomUUID();
  const draft = service.prepare(approved, message); service.prepare(refused, message);
  f.store.reject(refused);
  await assert.rejects(service.send(refused, message), { code: 'POLICY_DENIED' });
  f.store.approve(approved, draft.signingText, device.assert(approvalChallenge(draft.signingText), ORIGIN));
  assert.equal((await service.send(approved, message)).logId, '9007199254740993'); assert.equal(sends, 1);
});

test('the approver registry refuses unsafe files and duplicate credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approvers-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ApproverRegistry(root), { approver } = enrolled();
  registry.add(approver);
  assert.throws(() => registry.add(approver), { code: 'IDEMPOTENCY_CONFLICT' });
  if (process.platform !== 'win32') { fs.chmodSync(registry.file, 0o644);
  assert.throws(() => registry.list(), { code: 'CONFIG_INVALID' }); }
});

test('per-action approval windows and the post-approval commit window bound passkey approvals', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-windows-'));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), registry = new ApproverRegistry(root), rooms = new RoomAccessPolicy(db);
  t.after(() => { journal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let now = 1_000_000;
  const store = new ApprovalStore(journal, registry, () => now), { device, approver } = enrolled(); registry.add(approver);
  const engine = (window: (a: string) => number) => new AgentOperationEngine({ principal: 'local-mcp', journal, approvals: store,
    approvalWindow: window, definitions: AGENT_CONTROL_DEFINITIONS, now: () => now, rateLimit: () => ({ windowMs: 60000, perChat: 5, global: 20 }),
    adapter: { accountId: () => '123456789', inspect: async (_a, raw) => {
      const r = raw as { chatId: string; rule: { mode: 'manual' } };
      return { context: { kind: 'room-access', chatId: r.chatId, previous: rooms.rule(r.chatId), room: { title: null, type: null, memberCount: null } },
        validate: () => {}, execute: async () => { rooms.set(r.chatId, r.rule); return { status: 0 }; } };
    } } });
  const e = engine(action => action === 'grant_room_access' ? 30 * 60_000 : 15 * 60_000);
  const request = (chatId: string) => ({ chatId, rule: { mode: 'manual' } });
  const approve = (p: { requestId: string; signingText?: string }) => store.approve(p.requestId, p.signingText!, device.assert(approvalChallenge(p.signingText!), ORIGIN));

  const late = await e.prepare('grant_room_access', randomUUID(), request('111111111'));
  assert.equal(late.expiresAt - now, 30 * 60_000); assert.equal(JSON.parse(late.signingText!).commitWindowMs, 300_000);
  now += 29 * 60_000; approve(late);       // approved just before the 30-minute approval deadline
  now += 4 * 60_000;                       // commit after the approval deadline, inside the commit window
  assert.equal((await e.commit('grant_room_access', late.requestId, request('111111111'))).state, 'applied');

  const slow = await e.prepare('grant_room_access', randomUUID(), request('222222222'));
  now += 60_000; approve(slow);
  now += 5 * 60_000;                       // well before the approval deadline, but the commit window has elapsed
  assert.equal(store.state(slow.requestId), 'expired');
  await assert.rejects(e.commit('grant_room_access', slow.requestId, request('222222222')), { code: 'OPERATION_EXPIRED' });
  assert.equal(rooms.rule('222222222').mode, 'deny');

  const unapproved = await e.prepare('grant_room_access', randomUUID(), request('333333333'));
  now += 30 * 60_000;                      // never approved: the approval deadline passed
  await assert.rejects(e.commit('grant_room_access', unapproved.requestId, request('333333333')), { code: 'OPERATION_EXPIRED' });

  await assert.rejects(engine(() => 4 * 60_000).prepare('grant_room_access', randomUUID(), request('444444444')), { code: 'CONFIG_INVALID' });
  await assert.rejects(engine(() => 31 * 60_000).prepare('grant_room_access', randomUUID(), request('444444444')), { code: 'CONFIG_INVALID' });
});

test('read grants: deny and manual rooms only, bound to chat/tool/size, uses consumed atomically, revocable', async t => {
  const f = fixture(t), chat = '123456789', other = '987654321', denied = '555555555';
  const grant = (over: Partial<Parameters<RoomAccessPolicy['createReadGrant']>[0]> = {}) => f.rooms.createReadGrant({ grantId: randomUUID(), chatId: chat,
    tools: ['read_messages'], maxMessages: 10, uses: 2, expiresAt: Date.now() + 600_000, ...over });
  // A default-deny room takes a one-time grant and stays deny; confirmRead never opens it.
  const once = grant({ chatId: denied, uses: 1 });
  assert.throws(() => f.rooms.take(denied, { confirmRead: true }, 1), { code: 'POLICY_DENIED' });
  f.rooms.take(denied, { readGrant: { id: once.grantId, tool: 'read_messages' } }, 1);
  assert.throws(() => f.rooms.take(denied, { readGrant: { id: once.grantId, tool: 'read_messages' } }, 1), { code: 'POLICY_DENIED' });
  assert.equal(f.rooms.rule(denied).mode, 'deny');
  f.rooms.set(chat, { mode: 'immediate' });
  assert.throws(() => grant(), { code: 'POLICY_DENIED' }); // an open room needs no grant
  f.rooms.set(chat, { mode: 'manual', maxMessages: 20 });
  assert.throws(() => grant({ maxMessages: 21 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => grant({ expiresAt: Date.now() + 61 * 60_000 }), { code: 'INVALID_ARGUMENT' });
  const g = grant(), ref = { id: g.grantId, tool: 'read_messages' as const };
  assert.throws(() => f.rooms.take(chat, {}, 1), { code: 'POLICY_DENIED' });
  for (const bad of [{ id: g.grantId, tool: 'get_chat_meta' as const }, { id: randomUUID(), tool: 'read_messages' as const }])
    assert.throws(() => f.rooms.take(chat, { readGrant: bad }, 1), { code: 'POLICY_DENIED' });
  assert.throws(() => f.rooms.take(chat, { readGrant: ref }, 11), { code: 'POLICY_DENIED' });
  assert.throws(() => f.rooms.take(other, { readGrant: ref }, 1), { code: 'POLICY_DENIED' });
  f.rooms.take(chat, { readGrant: ref }, 5); f.rooms.take(chat, { readGrant: ref }, 5);
  f.rooms.check(chat, { readGrant: ref }, 5); // in-flight rechecks of an operation that used the last use still pass
  assert.throws(() => f.rooms.take(chat, { readGrant: ref }, 1), { code: 'POLICY_DENIED' });
  assert.equal(f.rooms.listReadGrants().length, 0);
  const h = grant({ tools: ['read_messages', 'get_chat_meta'] });
  assert.equal(f.rooms.revokeReadGrant(h.grantId), true);
  assert.throws(() => f.rooms.take(chat, { readGrant: { id: h.grantId, tool: 'read_messages' } }, 1), { code: 'POLICY_DENIED' });
  // A approved operation's confirmRead still authorizes its own manual read; broader rules never spend a grant.
  f.rooms.take(chat, { confirmRead: true }, 1);
  f.rooms.set(other, { mode: 'immediate' });
  f.rooms.take(other, {}, 1);

  // The read_room operation creates the grant only after approval and refuses non-manual rooms.
  const def = (await import('./agent-operation.ts')).agentOperationDefinition('read_room');
  assert.deepEqual(def.parseRequest({ chatId: chat, tools: ['get_chat_meta', 'read_messages'] }),
    { chatId: chat, maxMessages: 20, tools: ['get_chat_meta', 'read_messages'], ttlMinutes: 10, uses: 1 });
  for (const bad of [{ chatId: chat, tools: [] }, { chatId: chat, tools: ['send_message'] }, { chatId: chat, tools: ['read_messages', 'read_messages'] },
    { chatId: chat, tools: ['read_messages'], ttlMinutes: 61 }, { chatId: chat, tools: ['read_messages'], confirmRead: true }])
    assert.throws(() => def.parseRequest(bad), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => def.parseContext({ chatId: chat }, { kind: 'room-read', chatId: chat, rule: { mode: 'immediate' }, room: { title: null, type: null, memberCount: null } }), { code: 'INVALID_ARGUMENT' });
});

test('allowed recipients cover messages and photos to that exact room within a daily cap, never other actions, and revoke at once', async t => {
  const f = fixture(t), { RecipientPermissions } = await import('./recipient-permissions.ts');
  let now = Date.parse('2026-10-24T23:00:00+09:00');
  const recipients = new RecipientPermissions(f.journal, { dailyLimit: 2, timeZone: 'Asia/Seoul', now: () => now }), chat = '123456789';
  assert.equal(recipients.covers('send_message', { chatId: chat, text: 'x' }), undefined);
  recipients.grant(chat, 'client:fixture');
  for (const action of ['send_message', 'send_media', 'send_photo_bundle']) assert.equal(recipients.covers(action, { chatId: chat }), `recipient:${chat}`);
  for (const action of ['forward_message', 'leave_chat', 'edit_message', 'delete_message']) assert.equal(recipients.covers(action, { chatId: chat }), undefined);
  assert.equal(recipients.covers('send_message', { chatId: '987654321', text: 'x' }), undefined);
  const a = randomUUID();
  assert.equal(recipients.consume(a, 'send_message', { chatId: chat }), true); assert.equal(recipients.consume(a, 'send_message', { chatId: chat }), true);
  assert.equal(recipients.consume(randomUUID(), 'send_media', { chatId: chat }), true);
  assert.equal(recipients.consume(randomUUID(), 'send_message', { chatId: chat }), false); // daily cap 2
  now = Date.parse('2026-10-25T00:30:00+09:00'); // next local day in Seoul
  assert.equal(recipients.covers('send_message', { chatId: chat }), `recipient:${chat}`);
  const combined = recipients;
  assert.equal(combined.covers('send_message', { chatId: chat, text: 'x' }), `recipient:${chat}`);
  assert.equal(recipients.revoke(chat), true); assert.equal(recipients.covers('send_message', { chatId: chat }), undefined);
  assert.equal(recipients.consume(a, 'send_message', { chatId: chat }), false); // prior consumption record does not bypass revocation
  assert.throws(() => new RecipientPermissions(f.journal, { dailyLimit: 0, timeZone: 'Asia/Seoul' }), { code: 'CONFIG_INVALID' });
  // Paused sending still blocks an allowed recipient: SendPolicy applies after the approval step.
  recipients.grant(chat, 'operation');
  const policy = new SendPolicy({ ceiling: [chat], pausedAtStart: true, auditLogPath: path.join(f.root, 'audit') });
  const service = new AgentSendService({ principal: 'local-mcp', journal: f.journal, recipients: recipients, now: () => now, policy,
    adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture', send: async () => ({ status: 0, logId: '1' }) } });
  assert.throws(() => service.prepare(randomUUID(), { chatId: chat, text: 'paused' }), { code: 'POLICY_DENIED' });
});

test('revoking an allowed recipient immediately halts pending rate-limited sends on retry, ensuring zero external attempts', async t => {
  const f = fixture(t), { RecipientPermissions } = await import('./recipient-permissions.ts');
  let now = Date.parse('2026-10-24T23:00:00+09:00');
  const recipients = new RecipientPermissions(f.journal, { dailyLimit: 10, timeZone: 'Asia/Seoul', now: () => now }), chat = '123456789';
  recipients.grant(chat, 'client:fixture');

  let sendCalls = 0;
  const adapter = {
    accountId: () => '987654321',
    connected: () => true,
    context: () => 'fixture',
    send: async () => { sendCalls++; return { status: 0, logId: String(1000 + sendCalls) }; },
  };

  // Rate limit: perChat = 1 send per 60,000ms
  const policy = new SendPolicy({
    ceiling: [chat],
    pausedAtStart: false,
    rateLimit: { global: 10, perChat: 1, windowMs: 60_000 },
    auditLogPath: path.join(f.root, 'audit'),
  }, { now: () => now });

  const createService = () => new AgentSendService({
    principal: 'local-mcp',
    journal: f.journal,
    recipients: recipients,
    now: () => now,
    policy,
    adapter,
  });

  const service1 = createService();
  const id1 = randomUUID();
  service1.prepare(id1, { chatId: chat, text: 'first' });
  const id2 = randomUUID();
  service1.prepare(id2, { chatId: chat, text: 'second' });

  await service1.send(id1, { chatId: chat, text: 'first' });
  assert.equal(sendCalls, 1);

  // Second message hits the rate limit at commit/send time (after consuming approval)
  await assert.rejects(
    async () => { await service1.send(id2, { chatId: chat, text: 'second' }); },
    { code: 'RATE_LIMITED' }
  );
  assert.equal(sendCalls, 1); // External attempts still 1 (second was not sent)

  // Human revokes permission for this room
  recipients.revoke(chat);

  // Time advances past the rate limit window
  now += 61_000;

  // Retry the pending operation in a new service instance
  const service2 = createService();
  await assert.rejects(
    async () => { await service2.send(id2, { chatId: chat, text: 'second' }); },
    (err: any) => err?.code === 'POLICY_DENIED' || err?.code === 'APPROVAL_REQUIRED'
  );

  // CRITICAL: External attempts must remain 1 (zero additional external attempts for the revoked room)
  assert.equal(sendCalls, 1);
});


