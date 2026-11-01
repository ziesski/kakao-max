import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentSendJournal, AgentSendService, parseAgentMessage, clientMsgIdFor, SETTLE_GRACE_MS, type AgentMessage, type AgentSendAdapter } from './agent-send.ts';
import { LocoError } from '@kakao-max/protocol';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { SendPolicy } from './policy.ts';
import { KakaoError } from './errors.ts';

function fixture(t: { after(fn: () => void): void }, notification = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-'));
  let now = 1000000, context = 'local-version-1', account = '123456789', connected = true, calls = 0;
  let effect: AgentSendAdapter['send'] = async () => ({ status: 0, logId: '9007199254740993' });
  let history: AgentSendAdapter['findSent'];
  const msgIds: Array<number | undefined> = [];
  const policy = () => new SendPolicy({ ceiling: ['123456789','987654321'], notifyChatId: notification ? '123456789' : undefined,
    pausedAtStart: false, auditLogPath: path.join(root, 'audit.jsonl') }, { now: () => now });
  const adapter: AgentSendAdapter = { accountId: () => account, connected: () => connected,
    context: () => context, send: async (m, attempt) => { calls++; msgIds.push(attempt?.msgId); return effect(m, attempt); },
    roomCursor: () => '9007199254740000',
    findSent: async (chatId, msgId, since) => history ? history(chatId, msgId, since) : { found: false, complete: false } };
  const journals: AgentSendJournal[] = [];
  const create = () => {
    const journal = AgentSendJournal.open(root); journals.push(journal);
    const approvals = fixtureApprovals(journal, root, () => now);
    const p = policy(); const service = new AgentSendService({ principal: 'local-mcp', journal, adapter, policy: p, approvals: approvals.store, now: () => now, notifications: notification });
    return { service, journal, policy: p, approve: approvals.approve, approvals: approvals.store };
  };
  const current = create();
  t.after(() => { for (const j of journals) j.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message: AgentMessage = { chatId: '123456789', text: 'fixture-private-message 가' };
  return { ...current, root, message, create, calls: () => calls, msgIds: () => msgIds,
    effect: (value: AgentSendAdapter['send']) => { effect = value; },
    history: (value: AgentSendAdapter['findSent']) => { history = value; },
    advance: (ms: number) => { now += ms; }, context: (value: string) => { context = value; },
    account: (value: string) => { account = value; }, disconnect: () => { connected = false; } };
}

test('an approved immutable payload survives restart, preserves exact IDs and rejects changed fields', async t => {
  const f = fixture(t), id = randomUUID();
  const prepared = f.service.prepare(id, f.message); f.approve(prepared);
  assert.equal(prepared.approvalRequired, true);
  f.advance(100);
  assert.equal(f.service.prepare(id, f.message).signingText, prepared.signingText);
  assert.equal((await f.service.send(id, f.message)).logId, '9007199254740993');
  const restart = f.create();
  assert.equal((await restart.service.send(id, f.message)).state, 'sent_unverified');
  for (const changed of [{ ...f.message, chatId: '987654321' }, { ...f.message, text: f.message.text + ' ' },
    { ...f.message, replyToLogId: '42', replyToUserId: '43', replyToText: 'fixture quote' },
    { ...f.message, mentions: [{ userId: '42', at: [1], len: 1 }] }]) {
    await assert.rejects(restart.service.send(id, changed), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  f.account('987654321');
  await assert.rejects(restart.service.send(id, f.message), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.calls(), 1);
  for (const name of ['kakao.db','kakao.db-wal']) if (fs.existsSync(path.join(f.root, name))) {
    const bytes = fs.readFileSync(path.join(f.root, name));
    assert.equal(bytes.includes(Buffer.from(f.message.text)), false);
  }
});

test('a draft is not approved by possession, by an approval of other text, or without an approval store', async t => {
  const f = fixture(t), id = randomUUID(), draft = f.service.prepare(id, f.message);
  await assert.rejects(f.service.send(id, f.message), { code: 'APPROVAL_REQUIRED', retryable: false });
  const other = f.service.prepare(randomUUID(), { ...f.message, text: 'fixture other draft' });
  f.approvals.recordClientConfirmation(id, f.approvals.envelopeDigest(other.signingText), 'fixture');
  await assert.rejects(f.service.send(id, f.message), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.calls(), 0); assert.equal(f.journal.get(id)?.state, 'prepared');
  f.approve(draft);
  const noApprovals = new AgentSendService({ principal: 'local-mcp', journal: f.journal,
    adapter: { accountId: () => '123456789', connected: () => true, context: () => 'local-version-1', send: async () => { throw new Error('must not send'); } }, policy: f.policy, now: () => 1000000 });
  await assert.rejects(noApprovals.send(id, f.message), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.calls(), 0);
});

test('approval cannot outlive expiration or a changed context or policy', async t => {
  for (const mode of ['expiry','context','pause'] as const) {
    const f = fixture(t), id = randomUUID(), prepared = f.service.prepare(id, f.message); f.approve(prepared);
    if (mode === 'expiry') f.advance(300000);
    if (mode === 'context') f.context('new-version');
    if (mode === 'pause') f.policy.setPaused(true);
    await assert.rejects(f.service.send(id, f.message), { code: mode === 'expiry' ? 'OPERATION_EXPIRED' : 'OPERATION_STALE' });
    assert.equal(f.calls(), 0);
  }
});

test('durable sending claim precedes adapter and same ID cannot be attempted concurrently', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.effect(async () => {
    assert.equal(f.journal.get(id)?.state, 'sending');
    assert.ok(f.journal.get(id)?.attempted_at);
    await barrier; return { status: 0, logId: '9007199254740993' };
  });
  const pending = f.service.send(id, f.message);
  try {
    await assert.rejects(f.create().service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
    assert.equal(f.calls(), 1);
  } finally { release(); }
  assert.equal((await pending).state, 'sent_unverified');
});

test('failure before durable claim causes no external attempt', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  t.mock.method(f.journal, 'claim', () => { throw new KakaoError('INTERNAL', 'fixture disk failure'); });
  await assert.rejects(f.service.send(id, f.message), { code: 'INTERNAL' });
  assert.equal(f.calls(), 0); assert.equal(f.journal.get(id)?.state, 'approved');
});

test('success followed by outcome persistence failure leaves a restart-fenced attempt', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  const original = f.journal.transition.bind(f.journal);
  t.mock.method(f.journal, 'transition', (...[id, from, to, messageId]: Parameters<AgentSendJournal['transition']>) => {
    if (to === 'sent_unverified' || to === 'send_unknown') throw new KakaoError('INTERNAL', 'fixture outcome disk failure');
    return original(id, from, to, messageId);
  });
  await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(f.journal.get(id)?.state, 'sending'); f.journal.close();
  await assert.rejects(f.create().service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(f.calls(), 1);
});

test('post-write errors and malformed acknowledgements are uncertain and never automatically retryable', async t => {
  for (const result of ['CLOSED','TIMEOUT','POLICY_DENIED','NETWORK','numeric-id','status'] as const) {
    const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
    f.effect(async () => {
      if (result === 'numeric-id') return { status: 0, logId: Number('9007199254740993') } as any;
      if (result === 'status') return { status: -1 };
      if (result === 'CLOSED' || result === 'TIMEOUT') throw new LocoError(result, 'fixture connection lost after the write');
      throw new KakaoError(result, 'fixture after possible external effect');
    });
    await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
    await assert.rejects(f.create().service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
    assert.equal(f.calls(), 1);
  }
});

test('attempt rate limits survive journal and policy reconstruction', async t => {
  const f = fixture(t, true);
  for (let i = 0; i < 5; i++) {
    const id = randomUUID(); f.service.prepare(id, f.message); await f.service.send(id, f.message);
  }
  const restart = f.create(), id = randomUUID(); restart.service.prepare(id, f.message);
  await assert.rejects(restart.service.send(id, f.message), { code: 'RATE_LIMITED' });
  assert.equal(f.calls(), 5); assert.equal(restart.journal.get(id)?.state, 'approved');
  f.advance(60001); assert.equal((await restart.service.send(id, f.message)).status, 0);
});

test('the operator ceiling denies rooms outside it, and no ceiling still requires approval for a new room', t => {
  const f = fixture(t);
  const service = (ceiling: string[]) => new AgentSendService({ principal: 'local-mcp', journal: f.journal, approvals: f.approvals,
    policy: new SendPolicy({ ceiling, pausedAtStart: false, auditLogPath: path.join(f.root, 'deny-audit') }),
    adapter: { accountId: () => '123456789', connected: () => true, context: () => 'fixture', send: async () => { throw new Error('must not send'); } } });
  for (const ceiling of [['987654321'], ['*']]) assert.throws(() => service(ceiling).prepare(randomUUID(), f.message), { code: 'POLICY_DENIED' });
  assert.equal(service([]).prepare(randomUUID(), f.message).approvalRequired, true);
});

test('an out-of-ceiling notice room is denied for agents and the internal notifier before any effect', t => {
  const f = fixture(t);
  const policy = new SendPolicy({ ceiling: ['987654321'], notifyChatId: f.message.chatId,
    pausedAtStart: false, auditLogPath: path.join(f.root, 'notice-ceiling-audit') });
  for (const notifications of [false, true]) {
    const service = new AgentSendService({ principal: notifications ? 'local-notify' : 'local-mcp', journal: f.journal,
      adapter: { accountId: () => '123456789', connected: () => true, context: () => 'fixture',
        send: async () => { throw new Error('must never send'); } }, policy, notifications });
    assert.throws(() => service.prepare(randomUUID(), f.message), { code: 'POLICY_DENIED' });
  }
  assert.equal(f.calls(), 0);
});

test('only the daemon notifier skips approval for the notice destination; an agent service needs approval there', async t => {
  const f = fixture(t, true), agent = new AgentSendService({ principal: 'local-mcp', journal: f.journal, policy: f.policy, approvals: f.approvals,
    adapter: { accountId: () => '123456789', connected: () => true, context: () => 'fixture', send: async () => { throw new Error('must not send'); } } });
  const id = randomUUID();
  assert.equal(agent.prepare(id, f.message).approvalRequired, true);
  await assert.rejects(agent.send(id, f.message), { code: 'APPROVAL_REQUIRED' });
  const notice = randomUUID();
  assert.equal(f.service.prepare(notice, f.message).approvalRequired, false);
});

test('journal key loss fails closed', t => {
  const f = fixture(t), id = randomUUID(); f.service.prepare(id, f.message);
  fs.unlinkSync(path.join(f.root, 'agent-send.key'));
  assert.throws(() => AgentSendJournal.open(f.root), { code: 'CONFIG_INVALID' });
  assert.equal(fs.existsSync(path.join(f.root, 'agent-send.key')), false);
});

test('application contracts reject lossy IDs, unknown fields, ambiguous reply/mention combinations and malformed mention positions', () => {
  const base: AgentMessage = { chatId: '123456789', text: '@fixture' };
  for (const input of [{ ...base, chatId: Number('9007199254740993') }, { ...base, text: '' },
    { ...base, hidden: 'field' }, { ...base, replyToLogId: '1' },
    { ...base, replyToLogId: '1', replyToUserId: '2', mentions: [{ userId: '3', at: [1], len: 1 }] },
    { ...base, mentions: [{ userId: '3', at: [99], len: 1 }] }]) {
    assert.throws(() => parseAgentMessage(input as AgentMessage), { code: 'INVALID_ARGUMENT' });
  }
});

test('SQLite failure during claim rolls back the attempt before adapter entry', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  f.journal.db.db.exec(`CREATE TRIGGER reject_claim BEFORE UPDATE ON agent_send_operations
    WHEN NEW.state = 'sending' BEGIN SELECT RAISE(ABORT, 'fixture injected claim failure'); END;`);
  await assert.rejects(f.service.send(id, f.message), { code: 'INTERNAL' });
  assert.equal(f.journal.get(id)?.state, 'approved'); assert.equal(f.journal.get(id)?.attempted_at, null);
  assert.equal(f.calls(), 0);
  f.journal.db.db.exec('DROP TRIGGER reject_claim');
  assert.equal((await f.service.send(id, f.message)).status, 0);
});

test('a crash after the durable claim but before adapter entry is conservatively fenced', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  f.journal.transition(id, 'prepared', 'approved');
  assert.equal(f.journal.claim(id, f.policy.describe().rateLimit, 1000000), true);
  f.journal.close();
  const recovered = f.create();
  assert.equal(recovered.service.prepare(id, f.message).state, 'send_unknown');
  await assert.rejects(recovered.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(f.calls(), 0);
});

test('an approval from another journal generation cannot be replayed even with the same account and principal', async t => {
  const first = fixture(t), second = fixture(t), id = randomUUID();
  const prepared = first.service.prepare(id, first.message); first.approve(prepared);
  second.service.prepare(id, second.message);
  // Recording the first journal's envelope in the second journal does not match its own keyed envelope.
  second.approvals.recordClientConfirmation(id, second.approvals.envelopeDigest(prepared.signingText), 'fixture');
  await assert.rejects(second.service.send(id, second.message), { code: 'APPROVAL_REQUIRED' });
  assert.equal(second.calls(), 0);
});

test('replacing the local database cannot silently discard journal identity while reusing its key', t => {
  const f = fixture(t); f.journal.close();
  fs.unlinkSync(path.join(f.root, 'kakao.db'));
  assert.throws(() => AgentSendJournal.open(f.root), { code: 'CONFIG_INVALID' });
});

test('a send that certainly did not happen is reported as not sent and goes out on a retry with the same requestId', async t => {
  const failures: Array<[string, () => never]> = [
    ['NOT_CONNECTED', () => { throw new KakaoError('NOT_CONNECTED', 'fixture: no session before writing'); }],
    ['NOT_CONNECTED', () => { throw new LocoError('NOT_CONNECTED', 'fixture: socket gone before writing'); }],
    ['LOCO_STATUS', () => { throw new KakaoError('LOCO_STATUS', 'WRITE failed with status -805', { details: { command: 'WRITE', status: -805 } }); }],
    ['INVALID_ARGUMENT', () => { throw new LocoError('INVALID_ARGUMENT', 'fixture: refused before writing'); }]
  ];
  for (const [code, fail] of failures) {
    const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
    f.effect(async () => fail());
    await assert.rejects(f.service.send(id, f.message), (e: KakaoError) => e.code === code && /not sent/.test(e.message));
    assert.equal(f.journal.get(id)?.state, 'approved', `${code}: back to approved, not uncertain`);
    f.effect(async () => ({ status: 0, logId: '9007199254740993' }));
    assert.equal((await f.service.send(id, f.message)).logId, '9007199254740993');
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.msgIds(), [clientMsgIdFor(id), clientMsgIdFor(id)], 'the retry carries the same client message ID');
  }
});

test('a lost reply is settled from room history: found means sent, without sending again', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  f.effect(async () => { throw new LocoError('CLOSED', 'fixture connection lost after the write'); });
  const looked: Array<[string, number, string]> = [];
  f.history(async (chatId, msgId, since) => { looked.push([chatId, msgId, since]); return { found: true, logId: '9007199254741111' }; });
  const sent = await f.service.send(id, f.message);
  assert.equal(sent.logId, '9007199254741111'); assert.equal(f.journal.get(id)?.state, 'sent_unverified');
  assert.deepEqual(looked, [['123456789', clientMsgIdFor(id), '9007199254740000']]);
  assert.equal(f.calls(), 1);
});

test('an absent message counts as undelivered only after the grace period and complete history, then the same requestId sends it once', async t => {
  const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
  f.effect(async () => { throw new LocoError('CLOSED', 'fixture connection lost after the write'); });
  f.history(async () => ({ found: false, complete: true }));
  await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN' });
  assert.equal(f.journal.get(id)?.state, 'send_unknown', 'too recent to call undelivered');
  await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN' });
  assert.equal(f.calls(), 1, 'never resent while the outcome is open');

  f.advance(SETTLE_GRACE_MS);
  assert.equal(await f.service.settlePending(), 0);
  assert.equal(f.journal.get(id)?.state, 'approved', 'settled as not delivered; nothing sent in the background');
  assert.equal(f.calls(), 1);
  f.effect(async () => ({ status: 0, logId: '9007199254740993' }));
  assert.equal((await f.service.send(id, f.message)).logId, '9007199254740993');
  assert.equal(f.calls(), 2); assert.deepEqual(f.msgIds(), [clientMsgIdFor(id), clientMsgIdFor(id)]);
});

test('incomplete history or a failed lookup leaves the send uncertain and never resends', async t => {
  for (const lookup of [async () => ({ found: false as const, complete: false }), async () => { throw new LocoError('CLOSED', 'fixture lookup failed'); }]) {
    const f = fixture(t, true), id = randomUUID(); f.service.prepare(id, f.message);
    f.effect(async () => { throw new LocoError('TIMEOUT', 'fixture reply never came'); });
    f.history(lookup);
    await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN' });
    f.advance(SETTLE_GRACE_MS);
    assert.equal(await f.service.settlePending(), 1);
    await assert.rejects(f.service.send(id, f.message), { code: 'SEND_OUTCOME_UNKNOWN' });
    assert.equal(f.calls(), 1);
  }
});
