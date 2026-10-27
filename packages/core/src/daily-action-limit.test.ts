import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KakaoDb } from './db.ts';
import { DailyActionLimit } from './daily-action-limit.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-action-limit-'));
  const db = KakaoDb.open({ dir });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}

test('the cap survives a restart, resets on the next local day and counts each action separately', t => {
  const { db } = fixture(t);
  // 2026-10-25 23:30 in Seoul; the local day changes 30 minutes later.
  let now = Date.parse('2026-10-25T14:30:00Z');
  const limit = () => new DailyActionLimit(db, { action: 'add_friend', limit: 2, timeZone: 'Asia/Seoul', now: () => now });
  limit().reserve(); limit().reserve();
  const restarted = limit();
  assert.equal(restarted.usedToday(), 2);
  assert.throws(() => restarted.check(), { code: 'RATE_LIMITED', retryable: false });
  assert.throws(() => restarted.reserve(), { code: 'RATE_LIMITED' });
  assert.equal(restarted.usedToday(), 2, 'a refused reservation takes no slot');
  assert.equal(new DailyActionLimit(db, { action: 'block_user', limit: 1, timeZone: 'Asia/Seoul', now: () => now }).usedToday(), 0);
  now += 31 * 60_000;
  assert.equal(restarted.usedToday(), 0); restarted.check(); restarted.reserve();
  assert.equal(restarted.usedToday(), 1);
});

test('stored uses keep no target user', t => {
  const { db } = fixture(t);
  new DailyActionLimit(db, { action: 'add_friend', limit: 10, timeZone: 'UTC' }).reserve();
  const columns = (db.db.prepare('PRAGMA table_info(account_action_uses)').all() as Array<{ name: string }>).map(c => c.name);
  assert.deepEqual(columns, ['id', 'action', 'local_day', 'used_at']);
});

test('a limit below one is a configuration error', t => {
  const { db } = fixture(t);
  for (const limit of [0, -1, 1.5]) assert.throws(() => new DailyActionLimit(db, { action: 'add_friend', limit, timeZone: 'UTC' }), { code: 'CONFIG_INVALID' });
});
