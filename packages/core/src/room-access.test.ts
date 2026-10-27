import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KakaoDb } from './db.ts';
import { RoomAccessPolicy, parseRoomAccessRule } from './room-access.ts';
import { KakaoError } from './errors.ts';

const CHAT = '123456789';
const code = (code: string) => (e: unknown) => e instanceof KakaoError && e.code === code;
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-access-'));
  const db = KakaoDb.open({ dir });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-22T16:00:00Z');
  return { db, policy: new RoomAccessPolicy(db, () => now), setNow: (n: string) => { now = Date.parse(n); } };
}

test('room access is deny by default; setting, manual reads and temporary expiry require distinct approvals', t => {
  const { policy, setNow } = fixture(t);
  assert.throws(() => policy.take(CHAT, { confirmRead: true }), code('POLICY_DENIED'));
  policy.set(CHAT, { mode: 'manual', expiresAt: '2026-10-22T17:00:00Z', maxMessages: 10 });
  assert.throws(() => policy.take(CHAT), code('POLICY_DENIED'));
  assert.throws(() => policy.take(CHAT, { confirmRead: true }, 11), code('INVALID_ARGUMENT'));
  policy.take(CHAT, { confirmRead: true }, 10);
  assert.throws(() => policy.take(CHAT), code('POLICY_DENIED'), 'manual approval is not remembered');
  setNow('2026-10-22T17:00:00Z');
  assert.deepEqual(policy.rule(CHAT), { mode: 'deny' });
  assert.throws(() => policy.take(CHAT, { confirmRead: true }), code('POLICY_DENIED'));
});

test('scheduled access honors California time, midnight windows and both sides of DST', t => {
  const { policy, setNow } = fixture(t);
  policy.set(CHAT, { mode: 'scheduled', schedule: { timeZone: 'America/Los_Angeles', times: ['09:00', '23:58'], windowMinutes: 5 } });
  policy.check(CHAT);
  setNow('2026-10-22T16:05:00Z');
  assert.throws(() => policy.check(CHAT, { confirmRead: true }), code('POLICY_DENIED'));
  setNow('2026-10-23T07:01:00Z'); policy.check(CHAT);
  setNow('2026-12-01T17:00:00Z'); policy.check(CHAT);
  setNow('2026-12-01T16:00:00Z'); assert.throws(() => policy.check(CHAT), code('POLICY_DENIED'));
  policy.set(CHAT, { mode: 'scheduled', schedule: { timeZone: 'UTC', everyMinutes: 30, windowMinutes: 2 } });
  setNow('2026-12-01T16:31:00Z'); policy.check(CHAT);
  setNow('2026-12-01T16:32:00Z'); assert.throws(() => policy.check(CHAT), code('POLICY_DENIED'));
});

test('read budgets survive restart and rule changes; rechecks do not consume calls', t => {
  const { policy, db, setNow } = fixture(t);
  policy.set(CHAT, { mode: 'immediate', callsPerHour: 1 });
  policy.take(CHAT);
  policy.check(CHAT); policy.check(CHAT);
  assert.throws(() => new RoomAccessPolicy(db, () => Date.parse('2026-10-22T16:01:00Z')).take(CHAT), code('RATE_LIMITED'));
  policy.set(CHAT, { mode: 'immediate', callsPerHour: 1 });
  assert.throws(() => policy.take(CHAT), code('RATE_LIMITED'));
  setNow('2026-10-22T15:59:00Z'); assert.throws(() => policy.take(CHAT), code('RATE_LIMITED'));
  setNow('2026-10-22T17:00:00Z'); policy.take(CHAT);
});

test('global read budget is shared across rooms and malformed stored state fails closed', t => {
  const { policy, db } = fixture(t);
  for (let i = 1; i <= 61; i++) {
    const id = String(i);
    policy.set(id, { mode: 'immediate' });
    if (i <= 60) policy.take(id);
    else assert.throws(() => policy.take(id), code('RATE_LIMITED'));
  }
  db.setMeta(`room-access:${CHAT}`, '{');
  assert.throws(() => policy.check(CHAT), code('CONFIG_INVALID'));
});

test('invalid schedules, unbounded options, wildcard rooms and caller mutations cannot broaden access', t => {
  const { policy } = fixture(t);
  for (const rule of [null, { mode: 'all' }, { mode: 'immediate', allowUnread: true }, { mode: 'manual', maxMessages: 0 },
    { mode: 'scheduled' }, { mode: 'scheduled', schedule: { timeZone: 'UTC', everyMinutes: 1, windowMinutes: 2 } },
    { mode: 'scheduled', schedule: { timeZone: 'UTC', times: ['25:00'], windowMinutes: 1 } },
    { mode: 'scheduled', schedule: { timeZone: 'UTC', times: ['09:00'], everyMinutes: 60, windowMinutes: 1 } },
    { mode: 'scheduled', schedule: { timeZone: 'invalid', times: ['09:00'], windowMinutes: 1 } },
    { mode: 'immediate', expiresAt: 'tomorrow' }]) assert.throws(() => parseRoomAccessRule(rule), code('INVALID_ARGUMENT'));
  assert.throws(() => policy.set('*', { mode: 'immediate' }), code('INVALID_ARGUMENT'));
  const rule = { mode: 'immediate' as const, maxMessages: 2 };
  policy.set(CHAT, rule); rule.maxMessages = 100;
  assert.equal(policy.rule(CHAT).maxMessages, 2);
});

test('unread local preview requires explicit manual approval, a frozen bound, a small batch and short expiry', t => {
  const { policy } = fixture(t);
  for (const rule of [
    { mode: 'immediate', unreadPreviewAfterLogId: '0', expiresAt: '2026-10-22T16:20:00Z', maxMessages: 20 },
    { mode: 'manual', unreadPreviewAfterLogId: '0', maxMessages: 20 },
    { mode: 'manual', unreadPreviewAfterLogId: '0', expiresAt: '2026-10-22T16:20:00Z', maxMessages: 21 },
    { mode: 'manual', unreadPreviewAfterLogId: '-1', expiresAt: '2026-10-22T16:20:00Z', maxMessages: 20 },
    { mode: 'manual', unreadPreviewAfterLogId: '9223372036854775808', expiresAt: '2026-10-22T16:20:00Z', maxMessages: 20 }
  ]) assert.throws(() => parseRoomAccessRule(rule), code('INVALID_ARGUMENT'));
  const rule = { mode: 'manual', unreadPreviewAfterLogId: '0', expiresAt: '2026-10-22T16:20:00Z', maxMessages: 20 };
  assert.throws(() => policy.set(CHAT, { ...rule, expiresAt: '2026-10-22T17:00:00Z' }), code('INVALID_ARGUMENT'));
  policy.set(CHAT, rule);
  assert.throws(() => policy.take(CHAT), code('POLICY_DENIED'));
  policy.take(CHAT, { confirmRead: true }, 20);
});

test('the memo chat is readable by default in ask mode; a stored rule, including deny, still wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-memo-')), db = KakaoDb.open({ dir });
  try {
    const policy = new RoomAccessPolicy(db, Date.now, { isMemoChat: id => id === CHAT });
    assert.deepEqual(policy.rule(CHAT), { mode: 'immediate' });
    assert.deepEqual(policy.rule('222'), { mode: 'deny' });
    policy.take(CHAT, {}, 1);
    policy.tighten(CHAT, { mode: 'deny' });
    assert.throws(() => policy.take(CHAT, {}, 1), code('POLICY_DENIED'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('forgetting a left room never broadens: drops rules the default covers, otherwise stores deny', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-access-forget-'));
  const db = KakaoDb.open({ dir });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-10-22T16:00:00Z');
  const ask = new RoomAccessPolicy(db, () => now), trust = new RoomAccessPolicy(db, () => now, { mode: 'trust' });
  ask.set(CHAT, { mode: 'deny' });
  ask.createReadGrant({ grantId: 'g1', chatId: CHAT, tools: ['read_messages'], maxMessages: 10, uses: 1, expiresAt: now + 60_000 });
  assert.deepEqual(ask.forgetRoom(CHAT, 'leave_chat'), { rule: false, readGrants: 1 }, 'a stored deny stays');
  assert.equal(ask.readGrant('g1')!.revoked, true);
  ask.set(CHAT, { mode: 'immediate' });
  assert.deepEqual(ask.forgetRoom(CHAT, 'other_device'), { rule: true, readGrants: 0 });
  assert.equal(db.getMeta(`room-access:${CHAT}`), undefined, 'ask mode: back to the deny default');
  trust.set(CHAT, { mode: 'immediate' }); trust.forgetRoom(CHAT, 'leave_chat');
  assert.deepEqual(trust.rule(CHAT), { mode: 'immediate' }, 'trust mode: back to its default');
  trust.set(CHAT, { mode: 'manual' }); trust.forgetRoom(CHAT, 'leave_chat');
  assert.deepEqual(trust.rule(CHAT), { mode: 'deny' }, 'dropping a narrower trust-mode rule would broaden it');
  db.setMeta(`room-access:${CHAT}`, '{corrupt'); ask.forgetRoom(CHAT, 'login_list');
  assert.deepEqual(ask.rule(CHAT), { mode: 'deny' });
});

test('returning to the default acts at once only when it does not broaden; reset is the approved path and is audited', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-access-default-'));
  const db = KakaoDb.open({ dir });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-10-22T16:00:00Z');
  const ask = new RoomAccessPolicy(db, () => now, { isMemoChat: id => id === '222' });
  assert.deepEqual(ask.restoreDefault(CHAT), { rule: { mode: 'deny' }, changed: false }, 'nothing stored');
  ask.set(CHAT, { mode: 'immediate' });
  assert.deepEqual(ask.restoreDefault(CHAT), { rule: { mode: 'deny' }, changed: true });
  assert.equal(ask.hasStoredRule(CHAT), false);
  ask.set(CHAT, { mode: 'deny' });
  assert.deepEqual(ask.restoreDefault(CHAT).changed, true, 'a stored deny in a deny-default room just goes away');
  ask.set('222', { mode: 'manual' });
  assert.throws(() => ask.restoreDefault('222'), code('APPROVAL_REQUIRED'), 'memo chat default is broader than manual');
  assert.deepEqual(ask.rule('222'), { mode: 'manual' });
  assert.deepEqual(ask.reset('222'), { mode: 'immediate' });
  assert.deepEqual(ask.rule('222'), { mode: 'immediate' });
  assert.equal(ask.hasStoredRule('222'), false);
  const audits = (db.db.prepare("SELECT value FROM meta WHERE key LIKE 'room-access-audit:%'").all() as Array<{ value: string }>)
    .map(r => JSON.parse(r.value)).filter(a => a.reason === 'reset');
  assert.equal(audits.length, 3);
  assert.ok(audits.every(a => a.rule === null && a.previous !== null));
  db.setMeta('room-access:222', '{corrupt');
  assert.throws(() => ask.restoreDefault('222'), code('APPROVAL_REQUIRED'), 'an unreadable rule counts as deny');
  db.setMeta(`room-access:${CHAT}`, '{corrupt');
  assert.equal(ask.restoreDefault(CHAT).changed, true);
  for (const bad of ['0', 'abc', '']) assert.throws(() => ask.restoreDefault(bad), code('INVALID_ARGUMENT'));
});
