import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { AGENT_CONTROL_ACTIONS, AgentOperationEngine, type AgentOperationDefinition } from './agent-operation.ts';
import { AGENT_MUTATION_ACTIONS } from './agent-mutation.ts';
import { AgentSendJournal } from './agent-send.ts';
import { TRUST_APPROVED_ACTIONS, agentModeApproves } from './agent-mode.ts';
import { describeConfig, loadConfig } from './config.ts';
import { KakaoDb } from './db.ts';
import { RecipientPermissions } from './recipient-permissions.ts';
import { RoomAccessPolicy } from './room-access.ts';

const CHAT = '123456789';

function config(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mode-config-'));
  try { return loadConfig({ envPath: path.join(dir, '.env.local'), env: { KAKAO_DATA_DIR: dir, ...env } }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('agent mode defaults to ask and sets ask/trust policy defaults; explicit operator values win', () => {
  const ask = config({});
  assert.equal(ask.agentMode, 'ask'); assert.equal(ask.agentModeSource, 'default');
  assert.equal(ask.recipientDailyLimit, 50); assert.equal(ask.automationMaxTier, 1);
  assert.match(describeConfig(ask), /agentMode=ask\(default\)/);

  const trust = config({ KAKAO_AGENT_MODE: 'Trust' });
  assert.equal(trust.agentMode, 'trust'); assert.equal(trust.agentModeSource, 'setting');
  assert.equal(trust.recipientDailyLimit, null); assert.equal(trust.automationMaxTier, 3);
  assert.match(describeConfig(trust), /agentMode=trust /);

  const capped = config({ KAKAO_AGENT_MODE: 'trust', KAKAO_RECIPIENT_DAILY_LIMIT: '20', KAKAO_AUTOMATION_MAX_TIER: '1' });
  assert.equal(capped.recipientDailyLimit, 20); assert.equal(capped.automationMaxTier, 1);
  assert.equal(config({ KAKAO_AGENT_MODE: 'ask' }).agentModeSource, 'setting');
});

test('unknown modes, tiers and archive flags outside trust fail closed', () => {
  const refused: Array<Record<string, string>> = [{ KAKAO_AGENT_MODE: 'open' }, { KAKAO_AGENT_MODE: 'guarded' }, { KAKAO_AUTOMATION_MAX_TIER: '4' },
    { KAKAO_VAULT_AUTO_SAVE: 'true' }, { KAKAO_AGENT_MODE: 'ask', KAKAO_VAULT_AUTO_SAVE: '1' }];
  for (const env of refused) {
    assert.throws(() => config(env), { code: 'CONFIG_INVALID' }, JSON.stringify(env));
  }
  assert.equal(config({ KAKAO_AGENT_MODE: 'trust', KAKAO_VAULT_AUTO_SAVE: 'true' }).vaultAutoSave, true);
});

test('trust reads rooms without a rule, but an explicit or expired rule still decides', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mode-rooms-'));
  const db = KakaoDb.open({ dir });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-25T00:00:00Z');
  const ask = new RoomAccessPolicy(db, () => now), trust = new RoomAccessPolicy(db, () => now, { mode: 'trust' });
  assert.deepEqual(ask.rule(CHAT), { mode: 'deny' });
  assert.throws(() => ask.check(CHAT), { code: 'POLICY_DENIED' });
  assert.deepEqual(trust.rule(CHAT), { mode: 'immediate' });
  trust.check(CHAT, {}, 10);
  assert.throws(() => trust.check(CHAT, {}, 51), { code: 'INVALID_ARGUMENT' }); // the room message limit still applies

  trust.tighten(CHAT, { mode: 'deny' }); // the person revoked this room
  assert.throws(() => trust.check(CHAT), { code: 'POLICY_DENIED' });
  trust.set('987654321', { mode: 'immediate', expiresAt: '2026-10-25T01:00:00Z' });
  now += 2 * 3600_000; // an expired rule falls back to deny, never to the trust default
  assert.deepEqual(trust.rule('987654321'), { mode: 'deny' });
});

test('trust allows sends to any exact room, without a daily cap unless the operator set one', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mode-recipients-'));
  const journal = AgentSendJournal.open(root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = { chatId: CHAT, text: 'hi' };
  const ask = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  assert.equal(ask.covers('send_message', message), undefined);

  const trust = new RecipientPermissions(journal, { dailyLimit: null, timeZone: 'UTC', allRooms: true });
  assert.equal(trust.covers('send_message', message), `trust:${CHAT}`);
  for (let i = 0; i < 60; i++) assert.equal(trust.consume(randomUUID(), 'send_message', message), true);
  assert.equal(trust.covers('forward_message', message), undefined); // not a room send
  assert.equal(trust.covers('send_message', { chatId: '../1', text: 'x' }), undefined);
  assert.deepEqual(trust.list(), []); // nothing was granted; nothing to revoke

  const capped = new RecipientPermissions(journal, { dailyLimit: 61, timeZone: 'UTC', allRooms: true });
  assert.equal(capped.consume(randomUUID(), 'send_message', message), true); // 61st today
  assert.equal(capped.covers('send_message', message), undefined);
  assert.equal(capped.consume(randomUUID(), 'send_message', message), false);
});

test('trust approves account changes but never pause release, new permissions or room creation', () => {
  for (const action of TRUST_APPROVED_ACTIONS) {
    assert.ok([...AGENT_CONTROL_ACTIONS, ...AGENT_MUTATION_ACTIONS, 'forward_message'].includes(action), action);
    assert.equal(agentModeApproves('ask', action), false);
    assert.equal(agentModeApproves('trust', action), true);
  }
  for (const action of ['resume_sending', 'grant_room_access', 'allow_recipient', 'read_room', 'create_direct_chat', 'send_message']) {
    assert.equal(agentModeApproves('trust', action), false, action);
  }
});

test('the write engine runs a trust-approved action without approval and still asks for everything else', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mode-engine-'));
  const journal = AgentSendJournal.open(root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let executions = 0;
  const fixture = (action: string): AgentOperationDefinition<{ chatId: string }, { kind: 'fixture' }> => ({
    action, effect: 'local', parseRequest: input => ({ chatId: (input as { chatId: string }).chatId }),
    parseContext: () => ({ kind: 'fixture' }), scope: r => `room:${r.chatId}`
  });
  const adapter = { accountId: () => '111111111',
    inspect: async () => ({ context: { kind: 'fixture' }, validate: () => {}, execute: async () => { executions++; return { status: 0 }; } }) };
  const engine = (mode: 'ask' | 'trust') => new AgentOperationEngine({ principal: 'local-mcp', journal, adapter,
    definitions: [fixture('mark_read'), fixture('resume_sending')], approvals: fixtureApprovals(journal, root).store,
    modeApproves: action => agentModeApproves(mode, action) });

  const askId = randomUUID();
  assert.equal((await engine('ask').prepare('mark_read', askId, { chatId: CHAT })).approvalRequired, true);
  await assert.rejects(engine('ask').commit('mark_read', askId, { chatId: CHAT }), { code: 'APPROVAL_REQUIRED' });

  const trustId = randomUUID();
  assert.equal((await engine('trust').prepare('mark_read', trustId, { chatId: CHAT })).approvalRequired, false);
  assert.equal((await engine('trust').commit('mark_read', trustId, { chatId: CHAT })).state, 'applied');
  assert.equal(executions, 1);

  const resumeId = randomUUID();
  assert.equal((await engine('trust').prepare('resume_sending', resumeId, { chatId: CHAT })).approvalRequired, true);
  await assert.rejects(engine('trust').commit('resume_sending', resumeId, { chatId: CHAT }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(executions, 1);
});
