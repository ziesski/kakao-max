import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KakaoDb } from './db.ts';
import { FriendsStore } from './friends.ts';
import { KakaoError } from './errors.ts';

// FriendsStore over a real SQLite file in a temp dir. All ids and names are made up.

const CREDS = { accessToken: 'fake-token', deviceUUID: 'fake-uuid' };

function store(friends: Array<{ userId: string; nickName: string; type?: number }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-friends-'));
  const kdb = KakaoDb.open({ dir });
  const insert = kdb.db.prepare('INSERT INTO friends (user_id, data) VALUES (?, ?)');
  for (const f of friends) insert.run(f.userId, JSON.stringify(f));
  return { friends: new FriendsStore(kdb), reopen: () => new FriendsStore(KakaoDb.open({ dir })) };
}

test('unblocking a friend blocked here restores the type it had, across restarts', () => {
  const { friends, reopen } = store([{ userId: '123456789', nickName: '홍길동', type: 1 }]);
  friends.setBlocked('123456789', true);
  assert.equal(friends.get('123456789')?.type, 9);
  assert.deepEqual(reopen().listBlocked().map((f) => f.userId), ['123456789']);

  const again = reopen();
  again.setBlocked('123456789', false);
  assert.equal(again.get('123456789')?.type, 1);
  assert.equal(again.get('123456789')?.typeBeforeBlock, undefined);
});

test('unblocking an entry that was already blocked in the address book does not make it a friend', () => {
  const { friends } = store([{ userId: '123456789', nickName: '홍길동', type: 9 }]);
  friends.setBlocked('123456789', false);
  assert.equal(friends.get('123456789')?.type, undefined);
  assert.equal(friends.listBlocked().length, 0);
});

test('blocking twice keeps the original type', () => {
  const { friends } = store([{ userId: '123456789', nickName: '홍길동', type: 1 }]);
  friends.setBlocked('123456789', true);
  friends.setBlocked('123456789', true);
  friends.setBlocked('123456789', false);
  assert.equal(friends.get('123456789')?.type, 1);
});

test('add rejects an HTTP 200 answer with a non-zero status and keeps the store unchanged', async (t) => {
  const { friends } = store([]);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: -1001 }), { status: 200 }));
  await assert.rejects(
    friends.add(CREDS, '123456789'),
    (e: unknown) => e instanceof KakaoError && e.code === 'LOCO_STATUS' && (e.details as any)?.status === -1001
  );
  assert.equal(friends.size, 0);
});

test('add stores the returned friend on status 0', async (t) => {
  const { friends } = store([]);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ status: 0, friend: { userId: 123456789, nickName: '홍길동', type: 1 } }), { status: 200 })
  );
  await friends.add(CREDS, '123456789');
  assert.equal(friends.get('123456789')?.nickName, '홍길동');
});
