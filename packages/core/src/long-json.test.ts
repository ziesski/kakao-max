import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { longReplacer, longReviver } from './long-json.ts';
import { KakaoDb } from './db.ts';
import { MessageStore } from './message-store.ts';

// bson is the protocol package's dependency; resolve it from there rather than declaring it here.
const { Long } = createRequire(import.meta.resolve('@kakao-max/protocol'))('bson');

test('longReplacer writes BSON Longs and bigints as decimal strings', () => {
  const raw = { revision: Long.fromString('1314563041929588736'), n: 7n, nested: [{ id: Long.fromNumber(42) }], s: 'x' };
  assert.deepEqual(JSON.parse(JSON.stringify(raw, longReplacer)), {
    revision: '1314563041929588736',
    n: '7',
    nested: [{ id: '42' }],
    s: 'x'
  });
});

test('longReviver turns the old {low, high, unsigned} shape into the same decimal string', () => {
  for (const v of ['3954722195089260545', '-5', '0', '9223372036854775807', '-9223372036854775808']) {
    const old = JSON.stringify({ logId: Long.fromString(v) }); // the shape stored before longReplacer
    assert.match(old, /"low":/);
    assert.deepEqual(JSON.parse(old, longReviver), { logId: v });
  }
  const unsigned = JSON.stringify(Long.fromString('18446744073709551615', true));
  assert.equal(JSON.parse(unsigned, longReviver), '18446744073709551615');
  // Objects that only look similar are left alone.
  const others = { a: { low: 1, high: 2 }, b: { low: 1, high: 2, unsigned: false, extra: 1 }, c: { low: 1.5, high: 0, unsigned: false } };
  assert.deepEqual(JSON.parse(JSON.stringify(others), longReviver), others);
});

test('MessageStore stores Longs in raw as strings and reads old Long-shaped rows the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-json-'));
  const db = KakaoDb.open({ dir });
  const store = new MessageStore(db);
  store.saveMessage({ seq: 1, chatId: '55', messageId: '100', authorId: '7', text: 'a', sendAt: 1, raw: { logId: Long.fromString('3954722195089260545') } });
  const stored = (db.db.prepare('SELECT raw FROM messages WHERE message_id = ?').get('100') as { raw: string }).raw;
  assert.equal(stored, '{"logId":"3954722195089260545"}');

  // A row written before this change.
  db.db.prepare('UPDATE messages SET raw = ? WHERE message_id = ?').run(JSON.stringify({ logId: Long.fromString('3954722195089260545') }), '100');
  assert.deepEqual(store.getMessages('55')[0].raw, { logId: '3954722195089260545' });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
