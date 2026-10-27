import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { AgentPublicationService, normalizeAgentPublication, type AgentPublicationAction, type AgentPublicationInput, type AgentPublicationSnapshot } from './agent-publication.ts';
import { AgentSendJournal, AgentSendService } from './agent-send.ts';
import { SendPolicy } from './policy.ts';

function png(width = 2): string {
  const b = Buffer.alloc(33); b.set([137,80,78,71,13,10,26,10]); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(3, 20); return b.toString('base64');
}
const media = (): AgentPublicationInput => ({ chatId: '123456789', type: 2, fileName: 'fixture.png', dataBase64: png() });
const bundle = (): AgentPublicationInput => ({ chatId: '123456789', photos: [png(), png(3)] });
const forward = (): AgentPublicationInput => ({ chatId: '123456789', text: 'fixture forwarded text ', type: 1, extra: '{"fixture":true}' });
function fixture(t: { after(fn: () => void): void }, notification = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-publication-'));
  const journal = AgentSendJournal.open(root), journals = [journal];
  let sends = 0, fail = false, held: AgentPublicationSnapshot | undefined;
  const policy = new SendPolicy({ ceiling: ['123456789','987654321'], notifyChatId: notification ? '123456789' : undefined,
    pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  let gate: Promise<void> | undefined;
  const adapter = { accountId: () => '123456789', connected: () => true, context: () => 'local-version',
    send: async (_action: AgentPublicationAction, snapshot: AgentPublicationSnapshot) => {
      sends++; held = snapshot;
      assert.equal(journal.get(id)?.state, 'sending');
      assert.ok(snapshot.buffers.every(b => b.some(value => value !== 0)));
      if (gate) await gate;
      if (fail) throw new Error('fixture failure after external effect');
      return { status: 0, logId: '9007199254740993' };
    } };
  const approvals = fixtureApprovals(journal, root);
  const create = (store = journal) => new AgentPublicationService({ principal: 'local-mcp', journal: store, policy, adapter, approvals: fixtureApprovals(store, root).store, notifications: notification });
  let id = randomUUID();
  t.after(() => { for (const j of journals) j.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, journal, policy, adapter, service: create(), create, id: () => id, next: () => { id = randomUUID(); return id; }, approve: approvals.approve, approvals: approvals.store,
    wait: (value: Promise<void>) => { gate = value; }, calls: () => sends, held: () => held, fail: () => { fail = true; }, restart: () => { const j = AgentSendJournal.open(root); journals.push(j); return create(j); } };
}

test('binary and forward operations bind payload, room, type, metadata and photo order before any external attempt', async t => {
  for (const [action, input, changes] of [
    ['send_media', media(), [{ ...media(), dataBase64: png(4) }, { ...media(), fileName: 'changed.png' }, { ...media(), type: 18 }]],
    ['send_photo_bundle', bundle(), [{ ...bundle(), photos: [png(3), png()] }]],
    ['forward_message', forward(), [{ ...forward(), text: forward().text + ' ' }, { ...forward(), type: 2 }, { ...forward(), extra: '{"fixture":false}' }]]
  ] as Array<[AgentPublicationAction, AgentPublicationInput, AgentPublicationInput[]]>) {
    const f = fixture(t), id = f.id(), prepared = f.service.prepare(action, id, input);
    assert.equal(prepared.approvalRequired, true); assert.equal(f.calls(), 0);
    assert.equal(prepared.signingText.includes(input.dataBase64 ?? 'not present'), false);
    await assert.rejects(f.service.send(action, id, input), { code: 'APPROVAL_REQUIRED' });
    f.approve(prepared);
    for (const changed of [...changes, { ...input, chatId: '987654321' }]) {
      await assert.rejects(f.service.send(action, id, changed), { code: 'IDEMPOTENCY_CONFLICT' });
    }
    assert.equal(f.calls(), 0);
    const out = await f.service.send(action, id, input);
    assert.equal(out.logId, '9007199254740993'); assert.equal(out.state, 'sent_unverified');
    assert.ok(f.held()?.buffers.every(b => b.every(value => value === 0)));
    assert.equal((await f.restart().send(action, id, input)).requestId, id); assert.equal(f.calls(), 1);
    // Journal never stores raw payload, filename or binary digest in plaintext.
    const bytes = fs.readFileSync(path.join(f.root, 'kakao.db-wal'));
    assert.equal(bytes.includes(Buffer.from(input.fileName ?? input.text ?? 'fixture.png')), false);
    if (input.dataBase64) assert.equal(bytes.includes(Buffer.from(input.dataBase64, 'base64')), false);
  }
});

test('indeterminate upload/forward and failed outcome persistence survive restart without another attempt', async t => {
  for (const action of ['send_media','send_photo_bundle','forward_message'] as const) for (const diskFailure of [false,true]) {
    const f = fixture(t), input = action === 'send_media' ? media() : action === 'send_photo_bundle' ? bundle() : forward();
    const p = f.service.prepare(action, f.id(), input); f.approve(p);
    if (diskFailure) {
      f.journal.db.db.exec(`CREATE TRIGGER fixture_outcome_failure BEFORE UPDATE OF state ON agent_send_operations
        WHEN NEW.state IN ('sent_unverified','send_unknown') BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
    } else f.fail();
    await assert.rejects(f.service.send(action, f.id(), input), { code: 'SEND_OUTCOME_UNKNOWN', retryable: false });
    assert.equal(f.journal.get(f.id())?.state, diskFailure ? 'sending' : 'send_unknown');
    assert.ok(f.held()?.buffers.every(b => b.every(value => value === 0)));
    const restarted = f.restart();
    assert.equal(restarted.prepare(action, f.id(), input).state, 'send_unknown');
    await assert.rejects(restarted.send(action, f.id(), input), { code: 'SEND_OUTCOME_UNKNOWN' });
    assert.equal(f.calls(), 1);
  }
});

test('text and publications share request identities and durable attempt limits; bundles always require approval', async t => {
  const f = fixture(t, true), id = f.id();
  const p = f.service.prepare('send_media', id, media()); assert.equal(p.approvalRequired, false);
  const text = new AgentSendService({ principal: 'local-mcp', journal: f.journal, policy: f.policy,
    adapter: { ...f.adapter, send: async () => ({ status: 0, logId: '9007199254740993' }) } });
  assert.throws(() => text.prepare(id, { chatId: '123456789', text: 'fixture' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.service.send('send_media', id, media());
  const second = f.next();
  const b = f.service.prepare('send_photo_bundle', second, bundle()); assert.equal(b.approvalRequired, true);
  await assert.rejects(f.service.send('send_photo_bundle', second, bundle()), { code: 'APPROVAL_REQUIRED' });
  // Tighten the rate after one attempted publication, then prepare under the new policy.
  const limited = new SendPolicy({ ceiling: [], notifyChatId: '123456789', pausedAtStart: false, auditLogPath: path.join(f.root, 'limited-audit'), rateLimit: { windowMs: 60000, perChat: 1, global: 10 } });
  const limitedText = new AgentSendService({ principal: 'local-mcp', journal: f.journal, policy: limited, notifications: true,
    adapter: { ...f.adapter, send: async () => { throw new Error('must not send'); } } });
  const third = randomUUID(), m = { chatId: '123456789', text: 'fixture rate' };
  limitedText.prepare(third, m); await assert.rejects(limitedText.send(third, m), { code: 'RATE_LIMITED' });
  assert.equal(f.calls(), 1);
});

test('binary validation fails before journal/adapter: paths, malformed base64, size, metadata and unsupported photo headers', async t => {
  const f = fixture(t);
  const invalid = [{ ...media(), filePath: '/private/credential' }, { ...media(), dataBase64: 'Zh==' }, { ...media(), dataBase64: 'bad' },
    { ...media(), dataBase64: '' }, { ...media(), dataBase64: 'AA=='.repeat(6000000) }, { ...media(), width: 99 },
    { ...media(), fileName: '../private' }, { ...media(), type: 99 }, { ...media(), dataBase64: Buffer.from('not a photo').toString('base64') }];
  for (const input of invalid) assert.throws(() => f.service.prepare('send_media', f.id(), input), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeAgentPublication('send_photo_bundle', { ...bundle(), photos: [png()] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.journal.get(f.id()), undefined); assert.equal(f.calls(), 0);
  const snapshot = normalizeAgentPublication('send_media', { chatId: '123456789', type: 18, fileName: 'fixture.bin', dataBase64: 'AA==' });
  assert.equal(snapshot.descriptor.size, 1); snapshot.dispose(); assert.ok(snapshot.buffers[0].every(v => v === 0));
});


test('concurrent binary commits share one durable claim and preserve the in-flight snapshot until completion', async t => {
  const f = fixture(t, true), id = f.id(), payload = media();
  f.service.prepare('send_media', id, payload);
  let release!: () => void; f.wait(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.service.send('send_media', id, payload);
  assert.equal(f.calls(), 1); assert.ok(f.held()?.buffers[0].some(v => v !== 0));
  await assert.rejects(f.service.send('send_media', id, payload), { code: 'SEND_OUTCOME_UNKNOWN' });
  assert.ok(f.held()?.buffers[0].some(v => v !== 0));
  release(); await pending;
  assert.equal(f.calls(), 1); assert.ok(f.held()?.buffers[0].every(v => v === 0));
});
