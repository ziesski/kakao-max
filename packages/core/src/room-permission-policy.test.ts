import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { AgentSendJournal, AgentSendService } from './agent-send.ts';
import { AgentPublicationService } from './agent-publication.ts';
import { AgentMutationService } from './agent-mutation.ts';
import { RecipientPermissions } from './recipient-permissions.ts';
import { RoomAccessPolicy } from './room-access.ts';
import { SendPolicy } from './policy.ts';
import { loadConfig } from './config.ts';

const CHAT = '123456789', ACCOUNT = '987654321';
function fixture(t: { after(fn: () => void): void }, cap: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-permission-policy-'));
  let journal = AgentSendJournal.open(root), recipients = new RecipientPermissions(journal, { dailyLimit: 10, timeZone: 'UTC' }), calls = 0;
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const policy = () => new SendPolicy({ ceiling: cap, pausedAtStart: false, auditLogPath: path.join(root, 'audit'),
    rateLimit: { windowMs: 60000, perChat: 100, global: 100 } });
  const adapter = { accountId: () => ACCOUNT, connected: () => true, context: () => 'known local room metadata',
    send: async () => { calls++; return { status: 0, logId: String(calls) }; } };
  const approvals = () => fixtureApprovals(journal, root);
  const service = (p = policy()) => new AgentSendService({ principal: 'local-mcp', journal, policy: p, adapter, recipients: recipients, approvals: approvals().store });
  return { root, policy, service, adapter, journal: () => journal, recipients: () => recipients, calls: () => calls,
    approvals: () => approvals().store, approve: (p: { requestId: string; signingText?: string }) => approvals().approve(p),
    restart: () => { journal.close(); journal = AgentSendJournal.open(root); recipients = new RecipientPermissions(journal, { dailyLimit: 10, timeZone: 'UTC' }); } };
}

test('a new room needs human approval, then one recipient grant supports sends across restart and can be revoked', async t => {
  const f = fixture(t), message = { chatId: CHAT, text: 'fixture' }, first = randomUUID(), a = f.service();
  const p = a.prepare(first, message);
  assert.equal(p.approvalRequired, true);
  await assert.rejects(a.send(first, message), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.calls(), 0);
  f.approve(p); await a.send(first, message);
  const oneTimeOnly = randomUUID(); a.prepare(oneTimeOnly, message);
  await assert.rejects(a.send(oneTimeOnly, message), { code: 'APPROVAL_REQUIRED' });
  f.recipients().grant(CHAT, 'client:fixture');
  f.restart();
  const b = f.service(), next = randomUUID();
  assert.equal(b.prepare(next, message).approvalRequired, false); await b.send(next, message);
  assert.equal(new RoomAccessPolicy(f.journal().db).rule(CHAT).mode, 'deny');
  f.recipients().revoke(CHAT);
  const last = randomUUID(); assert.equal(b.prepare(last, message).approvalRequired, true);
  await assert.rejects(b.send(last, message), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.calls(), 2);
});

// Restores the intent of the tests removed in 6ca34d9 on the adopted rooms model: the grant lives in RecipientPermissions,
// never in SendPolicy, so granting one room neither opens another nor changes the policy digest of envelopes already prepared.
test('one room grant opens only that room, leaves other prepared envelopes valid, and revoking closes it immediately', async t => {
  const f = fixture(t), other = '555555555', s = f.service();
  const pendingOther = randomUUID(), otherMessage = { chatId: other, text: 'fixture other' };
  const otherPrepared = s.prepare(pendingOther, otherMessage);
  assert.equal(otherPrepared.approvalRequired, true);

  f.recipients().grant(CHAT, 'client:fixture');
  const id = randomUUID(), message = { chatId: CHAT, text: 'fixture' };
  assert.equal(s.prepare(id, message).approvalRequired, false); await s.send(id, message);
  assert.deepEqual(f.policy().describe().ceiling, []);

  const unsigned = randomUUID();
  assert.equal(s.prepare(unsigned, otherMessage).approvalRequired, true);
  await assert.rejects(s.send(unsigned, otherMessage), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.calls(), 1);
  f.approve(otherPrepared); await s.send(pendingOther, otherMessage); assert.equal(f.calls(), 2);

  f.recipients().revoke(CHAT);
  const after = randomUUID();
  assert.equal(s.prepare(after, message).approvalRequired, true);
  await assert.rejects(s.send(after, message), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.calls(), 2);
});

test('room eligibility is not approval, and a room grant cannot cross the operator ceiling or pause', async t => {
  const f = fixture(t), p = f.policy();
  assert.equal(p.withinCeiling(CHAT), true); assert.equal(p.decide(CHAT).allowed, true);
  assert.equal(f.service().prepare(randomUUID(), { chatId: CHAT, text: 'fixture' }).approvalRequired, true);
  for (const bad of ['0', '*', '01', '9223372036854775808']) assert.equal(p.withinCeiling(bad), false);
  const capped = f.policy(); capped.setPaused(true);
  assert.throws(() => f.service(capped).prepare(randomUUID(), { chatId: CHAT, text: 'fixture' }), { code: 'POLICY_DENIED' });
  const g = fixture(t, [ACCOUNT]); g.recipients().grant(CHAT, 'client:fixture');
  assert.throws(() => g.service().prepare(randomUUID(), { chatId: CHAT, text: 'fixture' }), { code: 'POLICY_DENIED' });
  assert.equal(g.calls(), 0);
});

function png(width = 2): string {
  const b = Buffer.alloc(33); b.set([137,80,78,71,13,10,26,10]); b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(3, 20); return b.toString('base64');
}
test('a room grant covers photos and bundles without an env allowlist, while forwarding still requires its own approval', async t => {
  const f = fixture(t), publication = new AgentPublicationService({ principal: 'local-mcp', journal: f.journal(), policy: f.policy(),
    adapter: f.adapter, recipients: f.recipients(), approvals: f.approvals() });
  f.recipients().grant(CHAT, 'client:fixture');
  const photo = { chatId: CHAT, fileName: 'fixture.png', dataBase64: png() }, photoId = randomUUID();
  assert.equal(publication.prepare('send_media', photoId, photo).approvalRequired, false);
  await publication.send('send_media', photoId, photo);
  const bundle = { chatId: CHAT, photos: [png(), png(3)] }, bundleId = randomUUID();
  assert.equal(publication.prepare('send_photo_bundle', bundleId, bundle).approvalRequired, false);
  await publication.send('send_photo_bundle', bundleId, bundle);
  const forwarded = { chatId: CHAT, text: 'fixture forward' }, forwardId = randomUUID();
  const p = publication.prepare('forward_message', forwardId, forwarded); assert.equal(p.approvalRequired, true);
  await assert.rejects(publication.send('forward_message', forwardId, forwarded), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.calls(), 2);
  f.approve(p); await publication.send('forward_message', forwardId, forwarded); assert.equal(f.calls(), 3);
});

test('a room grant does not approve deletion; an exact separately signed mutation is still required', async t => {
  const f = fixture(t); f.recipients().grant(CHAT, 'client:fixture');
  let mutations = 0;
  const service = new AgentMutationService({ principal: 'local-mcp', journal: f.journal(), policy: f.policy(), approvals: f.approvals(),
    adapter: { accountId: () => ACCOUNT, connected: () => true, inspect: async () => ({
      context: { kind: 'message', room: { maxLogId: '1', memberCount: 2 },
        target: { chatId: CHAT, messageId: '1', authorId: ACCOUNT, type: 1, text: 'fixture', attachment: null, revision: null } },
      validate: () => {}, execute: async () => { mutations++; return { status: 0 }; } }) } });
  const id = randomUUID(), request = { chatId: CHAT, logId: '1' }, p = await service.prepare('delete_message', id, request);
  await assert.rejects(service.commit('delete_message', id, request), { code: 'APPROVAL_REQUIRED' }); assert.equal(mutations, 0);
  assert.ok(p.signingText);
  f.approve(p); await service.commit('delete_message', id, request); assert.equal(mutations, 1);
});

test('the memo chat takes sends without a stored grant, inside the daily limit; other rooms still ask', async t => {
  const f = fixture(t), memo = new RecipientPermissions(f.journal(), { dailyLimit: 1, timeZone: 'UTC', isMemoChat: id => id === CHAT });
  assert.equal(memo.covers('send_message', { chatId: CHAT }), `memo:${CHAT}`);
  assert.equal(memo.covers('send_message', { chatId: '222222222' }), undefined);
  assert.equal(memo.covers('forward_message', { chatId: CHAT }), undefined);
  assert.equal(memo.consume(randomUUID(), 'send_message', { chatId: CHAT }), true);
  assert.equal(memo.covers('send_message', { chatId: CHAT }), undefined); // daily limit reached
  assert.deepEqual(memo.list(), []);
});

test('a send refused by the pause is audited as denied, with its reason and without its text', async t => {
  const f = fixture(t), p = f.policy(), message = { chatId: CHAT, text: 'fixture paused text' };
  f.recipients().grant(CHAT, 'client:fixture');
  p.setPaused(true);
  assert.throws(() => f.service(p).prepare(randomUUID(), message), (e: Error & { code?: string }) => e.code === 'POLICY_DENIED' && /paused/.test(e.message));
  const entries = fs.readFileSync(path.join(f.root, 'audit'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => [e.chatId, e.decision, /paused/.test(e.reason), e.textLength]), [[undefined, 'denied', true, message.text.length]]);
  assert.match(entries[0].targetRef, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(f.root, 'audit'), 'utf8').includes(CHAT), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'audit'), 'utf8').includes('fixture paused text'), false);
  assert.equal(f.calls(), 0);
});
