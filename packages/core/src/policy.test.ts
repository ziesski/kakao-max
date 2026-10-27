import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SendPolicy, loadPolicyConfig, type PolicyConfig } from './policy.ts';

const NOTIFY = '111111111', FRIEND = '222222222', STRANGER = '333333333';
const A = '444444444', B = '555555555', C = '666666666';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kkt-policy-'));
}

function makePolicy(over: Partial<PolicyConfig> = {}): { policy: SendPolicy; auditLogPath: string } {
  const auditLogPath = path.join(tmpDir(), 'audit.log');
  const policy = new SendPolicy({ notifyChatId: NOTIFY, ceiling: [FRIEND, NOTIFY], auditLogPath, pausedAtStart: false, ...over });
  return { policy, auditLogPath };
}

test('the notice destination is categorized separately but cannot bypass the ceiling', () => {
  const { policy } = makePolicy();
  const d = policy.decide(NOTIFY);
  assert.equal(d.category, 'notification');
  assert.equal(d.allowed, true);
  const restricted = makePolicy({ ceiling: [FRIEND] }).policy;
  assert.equal(restricted.decide(NOTIFY).allowed, false);
  assert.match(restricted.authorize(NOTIFY, 1).reason, /KAKAO_ROOM_CEILING/);
});

test('a room outside the operator ceiling is denied; human approval cannot override the ceiling', () => {
  const { policy } = makePolicy();
  const d = policy.decide(STRANGER);
  assert.equal(d.category, 'message-as-you');
  assert.equal(d.allowed, false);
  assert.match(d.reason, /KAKAO_ROOM_CEILING/);
  assert.equal(policy.decide(FRIEND).allowed, true);
});

test('no ceiling lets any valid room ID through to the approval check, never malformed IDs or wildcards', () => {
  const { policy } = makePolicy({ ceiling: [] });
  assert.equal(policy.withinCeiling(STRANGER), true);
  for (const bad of ['0', '*', '01', 'room', '9223372036854775808']) assert.equal(policy.withinCeiling(bad), false, bad);
  assert.equal(makePolicy({ ceiling: ['*'] }).policy.withinCeiling(STRANGER), false);
});

test('pause switch blocks ALL sends, including the notice destination', () => {
  const { policy } = makePolicy({ pausedAtStart: true });
  assert.equal(policy.isPaused(), true);
  assert.equal(policy.decide(NOTIFY).allowed, false);
  assert.equal(policy.decide(FRIEND).allowed, false);
  assert.match(policy.decide(NOTIFY).reason, /paused/);
  policy.setPaused(false);
  assert.equal(policy.decide(NOTIFY).allowed, true);
  assert.equal(policy.decide(FRIEND).allowed, true);
});

test('authorize appends an append-only JSONL audit entry with metadata only (no text)', () => {
  const { policy, auditLogPath } = makePolicy();
  policy.authorize(NOTIFY, 12);
  policy.authorize(STRANGER, 5);
  const lines = fs.readFileSync(auditLogPath, 'utf-8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.chatId, undefined);
  assert.match(first.targetRef, /^[a-f0-9]{64}$/);
  assert.equal(first.category, 'notification');
  assert.equal(first.decision, 'allowed');
  assert.equal(first.textLength, 12);
  assert.ok(typeof first.ts === 'string' && first.ts.length > 0);
  // the message text itself is never recorded — only its length
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'text'), false);
  const second = JSON.parse(lines[1]);
  assert.equal(second.chatId, undefined);
  assert.notEqual(second.targetRef, first.targetRef);
  assert.equal(second.decision, 'denied');
  assert.equal(second.textLength, 5);
  policy.authorize(NOTIFY, 1);
  const third = JSON.parse(fs.readFileSync(auditLogPath, 'utf8').trim().split('\n')[2]);
  assert.equal(third.targetRef, first.targetRef);
  for (const id of [NOTIFY, STRANGER]) assert.equal(fs.readFileSync(auditLogPath, 'utf8').includes(id), false);
  const other = makePolicy(); other.policy.authorize(NOTIFY, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(other.auditLogPath, 'utf8')).targetRef, first.targetRef);
});

test('describe() exposes the effective config + pause state', () => {
  const { policy, auditLogPath } = makePolicy({ ceiling: [B, A] });
  const d = policy.describe();
  assert.equal(d.paused, false);
  assert.equal(d.notifyChatId, NOTIFY);
  assert.deepEqual(d.ceiling, [A, B]);
  assert.equal(d.auditLogPath, auditLogPath);
});

test('loadPolicyConfig reads notice destination, ceiling, pause and audit path; the old allowlist key fails closed', () => {
  const dir = tmpDir();
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, `# policy\nKAKAO_NOTIFY_CHAT_ID=${NOTIFY}\nKAKAO_ROOM_CEILING=${A}, ${B} ; ${C}\nKAKAO_PAUSED=yes\n`);
  const cfg = loadPolicyConfig({ envPath, env: {} });
  assert.equal(cfg.notifyChatId, NOTIFY);
  assert.deepEqual(cfg.ceiling.sort(), [A, B, C]);
  assert.equal(cfg.pausedAtStart, true);
  // audit path defaults next to .env.local when unset
  assert.equal(cfg.auditLogPath, path.resolve(dir, 'kakao-mcp-audit.log'));
  assert.throws(() => loadPolicyConfig({ envPath, env: { KAKAO_ALLOWED_CHAT_IDS: A } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => loadPolicyConfig({ envPath, env: { KAKAO_ROOM_CEILING: '*' } }), { code: 'CONFIG_INVALID' });
});

test('loadPolicyConfig: no notice destination means every room is message-as-you', () => {
  const cfg = loadPolicyConfig({ envPath: path.join(tmpDir(), '.env.local'), env: {} });
  assert.equal(cfg.notifyChatId, undefined);
  assert.deepEqual(cfg.ceiling, []);
  assert.equal(new SendPolicy(cfg).categorize(A), 'message-as-you');
});

function rateLimited(over: Partial<PolicyConfig> = {}) {
  let t = 1_000_000;
  const auditLogPath = path.join(tmpDir(), 'audit.log');
  const policy = new SendPolicy(
    { notifyChatId: NOTIFY, ceiling: [A, B, C, NOTIFY], auditLogPath, pausedAtStart: false, rateLimit: { windowMs: 60_000, perChat: 2, global: 3 }, ...over },
    { now: () => t }
  );
  return { policy, auditLogPath, advance: (ms: number) => (t += ms) };
}

test('per-chat rate limit denies the send after the cap and releases after the window', () => {
  const { policy, advance } = rateLimited();
  assert.equal(policy.authorize(A, 1).allowed, true);
  assert.equal(policy.authorize(A, 1).allowed, true);
  const third = policy.authorize(A, 1);
  assert.equal(third.allowed, false);
  assert.match(third.reason, /rate limited: 2\/2 sends to this target/);
  assert.match(third.reason, /KAKAO_RATE_PER_CHAT/);
  // another chat is unaffected by A's per-chat cap
  assert.equal(policy.authorize(B, 1).allowed, true);
  advance(60_001);
  assert.equal(policy.authorize(A, 1).allowed, true);
});

test('global rate limit caps sends across chats, notices included', () => {
  const { policy } = rateLimited();
  assert.equal(policy.authorize(A, 1).allowed, true);
  assert.equal(policy.authorize(B, 1).allowed, true);
  assert.equal(policy.authorize(NOTIFY, 1).allowed, true);
  const d = policy.authorize(C, 1);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /KAKAO_RATE_GLOBAL/);
  assert.equal(policy.decide(NOTIFY).allowed, false);
});

test('denied sends do not consume rate budget; rate denials are audited', () => {
  const { policy, auditLogPath } = rateLimited();
  for (let i = 0; i < 5; i++) policy.authorize(STRANGER, 1); // outside the ceiling
  assert.equal(policy.authorize(A, 1).allowed, true);
  assert.equal(policy.authorize(A, 1).allowed, true);
  assert.equal(policy.authorize(A, 1).allowed, false);
  const last = JSON.parse(fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n').pop()!);
  assert.equal(last.decision, 'denied');
  assert.match(last.reason, /rate limited/);
  assert.equal(policy.describe().rateLimit.sendsInWindow, 2);
});

test('a limit of 0 disables that cap', () => {
  const { policy } = rateLimited({ rateLimit: { windowMs: 60_000, perChat: 0, global: 0 } });
  for (let i = 0; i < 20; i++) assert.equal(policy.authorize(A, 1).allowed, true);
});

test('user and account actions are blocked while paused and rate limited per target and globally', () => {
  const { policy, auditLogPath, advance } = rateLimited();
  policy.setPaused(true);
  assert.match(policy.authorizeAction('create:user:111', 'create_direct_chat').reason, /paused/);
  policy.setPaused(false);
  // no ceiling entry is needed: the target is a user, not a room
  assert.equal(policy.authorizeAction('create:user:111', 'create_direct_chat').allowed, true);
  assert.equal(policy.authorizeAction('create:user:111', 'create_direct_chat').allowed, true);
  const third = policy.authorizeAction('create:user:111', 'create_direct_chat');
  assert.equal(third.allowed, false);
  assert.match(third.reason, /rate limited: 2\/2 sends to this target/);
  // they share the global budget with sends (global cap is 3 here)
  assert.equal(policy.authorize(A, 1).allowed, true);
  assert.match(policy.authorizeAction('block_user:222', 'block_user').reason, /KAKAO_RATE_GLOBAL/);
  assert.equal(policy.decideAction('update_profile:1', 'update_my_profile').allowed, false);
  const entries = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries[0].chatId, undefined);
  assert.equal(entries[0].targetRef, entries[1].targetRef);
  assert.equal(fs.readFileSync(auditLogPath, 'utf8').includes('create:user:111'), false);
  assert.equal(entries.filter((e) => e.decision === 'allowed').length, 3);
  advance(60_001);
  assert.equal(policy.authorizeAction('create:user:222', 'create_direct_chat').allowed, true);
});

test('loadPolicyConfig reads the rate limit env, with defaults when unset', () => {
  const dir = tmpDir();
  const envPath = path.join(dir, '.env.local');
  const defaults = loadPolicyConfig({ envPath, env: {} });
  assert.deepEqual(defaults.rateLimit, { windowMs: 60_000, perChat: 5, global: 15 });
  fs.writeFileSync(envPath, 'KAKAO_RATE_WINDOW_SEC=30\nKAKAO_RATE_PER_CHAT=0\n');
  const cfg = loadPolicyConfig({ envPath, env: { KAKAO_RATE_GLOBAL: '7' } });
  assert.deepEqual(cfg.rateLimit, { windowMs: 30_000, perChat: 0, global: 7 });
  // garbage falls back to the default
  assert.equal(loadPolicyConfig({ envPath, env: { KAKAO_RATE_GLOBAL: 'lots' } }).rateLimit!.global, 15);
});
