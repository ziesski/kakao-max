import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KakaoDb } from './db.ts';
import { MessageStore, type StoredMessage } from './message-store.ts';
import { FriendsStore } from './friends.ts';
import { KnownChats } from './known-chats.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-db-'));
}

function msg(id: string, chatId: string, sendAt: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { seq: 0, chatId, messageId: id, authorId: '1', text: `m${id}`, type: 1, sendAt, ...extra };
}

test('open creates an owner-only database and is idempotent', () => {
  const dir = tmpDir();
  const a = KakaoDb.open({ dir });
  a.close();
  const b = KakaoDb.open({ dir });
  const versions = b.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  assert.deepEqual(versions.map((v) => v.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(b.path).mode & 0o777, 0o600);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy stores are imported once and kept as .migrated backups', () => {
  const dir = tmpDir();
  const lines = [
    JSON.stringify(msg('100', 'c1', 10)),
    JSON.stringify(msg('100', 'c1', 10)), // duplicate id
    JSON.stringify({ ...msg('101', 'c1', 11), raw: { a: 1 } }),
    '{"torn": ' // crash-truncated final line
  ];
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n'));
  fs.writeFileSync(
    path.join(dir, 'friends.json'),
    JSON.stringify([{ userId: '7', nickName: '홍길동', phoneNumber: '01000000000' }])
  );
  fs.writeFileSync(path.join(dir, 'known-chats.json'), JSON.stringify([{ id: 'c1', type: 'DirectChat', title: 'T' }]));

  const kdb = KakaoDb.open({ dir });
  const store = new MessageStore(kdb);
  assert.deepEqual(store.getMessages('c1').map((m) => m.messageId), ['100', '101']);
  assert.deepEqual(store.getMessages('c1')[1].raw, { a: 1 });
  const friends = new FriendsStore(kdb);
  assert.equal(friends.size, 1);
  assert.equal('phoneNumber' in (friends.get('7') as object), false);
  assert.deepEqual(new KnownChats(kdb).list(), [{ id: 'c1', type: 'DirectChat', title: 'T' }]);
  kdb.close();

  const files = fs.readdirSync(dir);
  for (const f of ['messages.jsonl', 'friends.json', 'known-chats.json']) {
    assert.ok(!files.includes(f), `${f} should be renamed`);
    const backup = files.find((x) => x.startsWith(`${f}.migrated-`));
    assert.ok(backup, `${f} backup missing`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);
  }

  // Reopening does not re-import (the originals are gone) and keeps the data.
  const again = KakaoDb.open({ dir });
  assert.equal(new MessageStore(again).getChatStats('c1').messageCount, 2);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MessageStore: insert vs merge, bounds, search, stats', () => {
  const dir = tmpDir();
  const kdb = KakaoDb.open({ dir });
  const s = new MessageStore(kdb);
  assert.equal(s.saveMessage(msg('1', 'c', 1)), true);
  assert.equal(s.saveMessage(msg('2', 'c', 2, { text: 'Hello World' })), true);
  assert.equal(s.saveMessage(msg('3', 'c', 3)), true);
  assert.equal(s.saveMessage(msg('local-x', 'c', 4)), true); // non-numeric id
  // Re-save merges new fields without erasing old ones.
  assert.equal(s.saveMessage({ ...msg('2', 'c', 2), text: 'Hello World', authorName: '홍길동', type: undefined }), false);
  const two = s.getMessages('c').find((m) => m.messageId === '2')!;
  assert.equal(two.authorName, '홍길동');
  assert.equal(two.type, 1);

  assert.deepEqual(s.getMessages('c', { limit: 2 }).map((m) => m.messageId), ['3', 'local-x']);
  assert.deepEqual(s.getMessages('c', { beforeLogId: '3' }).map((m) => m.messageId), ['1', '2', 'local-x']);
  assert.deepEqual(s.getMessages('c', { afterLogId: '1' }).map((m) => m.messageId), ['2', '3', 'local-x']);
  // Large logIds keep exact ordering (beyond 2^53).
  s.saveMessage(msg('3950000000000000123', 'big', 1));
  s.saveMessage(msg('3950000000000000124', 'big', 1));
  assert.deepEqual(s.getMessages('big', { beforeLogId: '3950000000000000124' }).map((m) => m.messageId), ['3950000000000000123']);

  assert.deepEqual(s.search('hello').map((m) => m.messageId), ['2']);
  assert.deepEqual(s.search('m', { chatId: 'c', limit: 2 }).map((m) => m.messageId), ['local-x', '3']);
  assert.deepEqual(s.getChatStats('c'), { messageCount: 4, lastSendAt: 4, lastMessage: 'mlocal-x', lastType: 1 });
  assert.deepEqual(s.getChatStats('none'), { messageCount: 0, lastSendAt: undefined, lastMessage: undefined, lastType: undefined });
  kdb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hidden messages ("delete for me") are left out of reads but kept in the table', () => {
  const dir = tmpDir();
  const kdb = KakaoDb.open({ dir });
  const store = new MessageStore(kdb);
  store.saveMessage(msg('100', 'c1', 10, { text: 'keep me' }));
  store.saveMessage(msg('101', 'c1', 11, { text: 'hide me' }));
  store.saveMessage(msg('200', 'c2', 12, { text: 'hide me too' }));

  const res = store.hideMessages('c1', ['101', '101', '999'], 1_700_000_000);
  assert.deepEqual(res, { hidden: ['101', '999'], alreadyHidden: [], notStored: ['999'] });
  assert.deepEqual(store.hideMessages('c1', ['101']), { hidden: [], alreadyHidden: ['101'], notStored: [] });

  assert.deepEqual(store.getMessages('c1').map((m) => m.messageId), ['100']);
  assert.deepEqual(store.getMessages('c1', { includeHidden: true }).map((m) => m.messageId), ['100', '101']);
  assert.deepEqual(store.search('hide me').map((m) => m.messageId), ['200']);
  assert.deepEqual(store.getChatStats('c1'), { messageCount: 1, lastSendAt: 10, lastMessage: 'keep me', lastType: 1 });

  // Re-saving a hidden message (a later sync) does not unhide it; a hidden id that arrives later stays hidden.
  store.saveMessage(msg('101', 'c1', 11, { authorName: '홍길동' }));
  store.saveMessage(msg('999', 'c1', 13));
  assert.deepEqual(store.getMessages('c1').map((m) => m.messageId), ['100']);
  assert.deepEqual([...store.hiddenIds(['100', '101', '999'])].sort(), ['101', '999']);
  const rows = kdb.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  assert.equal(Number(rows.n), 4, 'rows are kept');
  kdb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleted messages (type with 0x4000 bit) are left out of reads, search, and stats', () => {
  const dir = tmpDir();
  const kdb = KakaoDb.open({ dir });
  const store = new MessageStore(kdb);

  // Normal text (type 1) and normal photo (type 2)
  store.saveMessage(msg('300', 'c1', 10, { text: 'live message', type: 1 }));
  store.saveMessage(msg('301', 'c1', 11, { text: 'deleted text', type: 1 | 0x4000 })); // 16385
  store.saveMessage(msg('302', 'c1', 12, { text: 'deleted photo', type: 2 | 0x4000 })); // 16386

  // Normal getMessages excludes deleted
  assert.deepEqual(store.getMessages('c1').map((m) => m.messageId), ['300']);
  // includeDeleted: true brings them back
  assert.deepEqual(store.getMessages('c1', { includeDeleted: true }).map((m) => m.messageId), ['300', '301', '302']);

  // search excludes deleted
  assert.deepEqual(store.search('deleted').map((m) => m.messageId), []);
  assert.deepEqual(store.search('live').map((m) => m.messageId), ['300']);

  // getChatStats counts only non-deleted
  assert.deepEqual(store.getChatStats('c1'), { messageCount: 1, lastSendAt: 10, lastMessage: 'live message', lastType: 1 });

  // markDeleted on a normal message
  assert.equal(store.markDeleted('c1', '300'), true);
  assert.deepEqual(store.getMessages('c1').map((m) => m.messageId), []);
  const m300 = store.getMessage('c1', '300');
  assert.equal(m300?.type, 1 | 0x4000);

  // deletedIds accurately reports deleted message ids
  assert.deepEqual([...store.deletedIds(['300', '999'])], ['300']);

  // getNewestLogId returns the newest message id (including deleted)
  assert.equal(store.getNewestLogId('c1'), '302');

  kdb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removing fixed-text grants invalidates only pending work and preserves room permissions and attempted outcomes', t => {
  const dir = tmpDir(), old = KakaoDb.open({ dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Reconstruct the version-9 boundary in an isolated fixture, never an account database.
  old.db.exec(`DELETE FROM schema_migrations WHERE version = 10;
    CREATE TABLE standing_grants (grant_id TEXT PRIMARY KEY);
    CREATE TABLE standing_grant_uses (request_id TEXT PRIMARY KEY);
    INSERT INTO standing_grants VALUES ('fixture-grant');
    INSERT INTO recipient_permissions VALUES ('123456789', 1, 'client:fixture', NULL);`);
  const states = ['prepared', 'approved', 'sending', 'sent_unverified', 'send_unknown', 'rejected'];
  const insert = old.db.prepare(`INSERT INTO agent_send_operations
    (request_id,payload_digest,room_digest,context_digest,policy_digest,created_at,expires_at,state,category)
    VALUES (?, 'fixture', 'fixture', 'fixture', 'fixture', 1, 2, ?, 'message-as-you')`);
  for (const state of states) insert.run(`fixture-${state}`, state);
  old.close();
  const current = KakaoDb.open({ dir });
  try {
    const rows = current.db.prepare('SELECT request_id, state FROM agent_send_operations').all() as Array<{ request_id: string; state: string }>;
    for (const state of states) assert.equal(rows.find(r => r.request_id === `fixture-${state}`)!.state,
      state === 'prepared' || state === 'approved' ? 'stale' : state);
    assert.equal(current.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('standing_grants', 'standing_grant_uses')").all().length, 0);
    assert.equal(current.db.prepare('SELECT * FROM recipient_permissions').all().length, 1);
  } finally { current.close(); }
});
