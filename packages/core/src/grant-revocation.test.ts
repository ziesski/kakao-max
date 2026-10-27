import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSendJournal, AgentSendService, type RoomSendApprovals } from './agent-send.ts';
import { RecipientPermissions } from './recipient-permissions.ts';
import { SendPolicy } from './policy.ts';

for (const kind of ['recipient'] as const) {
  for (const revoke of [false, true]) {
    test(`${kind}: a rate-blocked send rechecks permission after restart (revoked=${revoke})`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-revocation-'));
      let journal = AgentSendJournal.open(root), now = Date.parse('2026-10-24T12:00:00Z'), sends = 0;
      t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const chatId = '123456789', message = { chatId, text: 'fixture' }, grantId = randomUUID();
      const grants = () => new RecipientPermissions(journal, { dailyLimit: 2, timeZone: 'UTC', now: () => now });
      const original = grants(); original.grant(chatId, 'client:fixture');
      const service = (recipients: RoomSendApprovals) => new AgentSendService({ principal: 'local-mcp', journal, recipients, now: () => now,
        policy: new SendPolicy({ ceiling: [chatId], pausedAtStart: false, auditLogPath: path.join(root, 'audit'),
          rateLimit: { windowMs: 60000, perChat: 1, global: 1 } }, { now: () => now }),
        adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture',
          send: async () => { sends++; return { status: 0, logId: String(sends) }; } } });
      const first = randomUUID(), pending = randomUUID();
      const a = service(original); a.prepare(first, message); await a.send(first, message);
      // Fresh policy memory simulates a reconnect; the durable budget still blocks the second send.
      const b = service(original); b.prepare(pending, message);
      await assert.rejects(b.send(pending, message), { code: 'RATE_LIMITED' });
      assert.equal(journal.get(pending)?.state, 'approved'); assert.equal(sends, 1);
      if (revoke) original.revoke(chatId);
      journal.close(); journal = AgentSendJournal.open(root); now += 61000;
      const restarted = service(grants());
      if (revoke) {
        await assert.rejects(restarted.send(pending, message), { code: 'APPROVAL_REQUIRED' });
        assert.equal(journal.get(pending)?.attempted_at, null); assert.equal(sends, 1);
      } else {
        assert.equal((await restarted.send(pending, message)).state, 'sent_unverified'); assert.equal(sends, 2);
      }
      // Revoking authority never erases the journal or causes an already acknowledged send to be resent.
      assert.equal((await restarted.send(first, message)).state, 'sent_unverified');
      assert.equal(sends, revoke ? 1 : 2);
    });
  }
}

test('recipient reservations remain scoped to their room, action class and local day', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipient-reservation-'));
  const journal = AgentSendJournal.open(root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-24T23:59:00Z');
  const grants = new RecipientPermissions(journal, { dailyLimit: 1, timeZone: 'UTC', now: () => now });
  const id = randomUUID(), message = { chatId: '123456789', text: 'fixture' };
  grants.grant(message.chatId, 'client:fixture'); grants.grant('987654321', 'client:fixture');
  assert.equal(grants.consume(id, 'send_message', message), true);
  assert.equal(grants.consume(id, 'send_message', message), true);
  assert.equal(grants.consume(id, 'send_message', { ...message, chatId: '987654321' }), false);
  assert.equal(grants.consume(id, 'delete_message', message), false);
  now += 120000;
  assert.equal(grants.consume(id, 'send_message', message), false);
  assert.equal(grants.get(message.chatId)!.usedToday, 0);
});
