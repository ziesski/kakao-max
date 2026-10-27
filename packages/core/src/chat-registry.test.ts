import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelMember, ChannelMeta } from '@kakao-max/protocol';
import { ChatRegistry } from './chat-registry.ts';
import { KakaoDb } from './db.ts';
import { KnownChats } from './known-chats.ts';
import { MessageStore } from './message-store.ts';
import { FriendsStore } from './friends.ts';

const SELF = '1';

function setup(metas: Record<string, ChannelMeta> = {}, fetchMembers?: (chatId: string, userIds: string[]) => Promise<ChannelMember[]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-registry-'));
  const db = KakaoDb.open({ dir });
  const knownChats = new KnownChats(db);
  const store = new MessageStore(db);
  const friends = new FriendsStore(db);
  const fetched: string[] = [];
  const logs: string[] = [];
  const reg = new ChatRegistry({
    knownChats,
    store,
    friends,
    selfUserId: () => SELF,
    fetchMeta: async (chatId) => {
      fetched.push(chatId);
      const m = metas[chatId];
      if (!m) throw new Error(`no meta for ${chatId}`);
      return structuredClone(m);
    },
    fetchMembers,
    log: (l) => logs.push(l)
  });
  const done = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { reg, db, knownChats, store, fetched, logs, done };
}

const direct = (chatId: string, otherId: string, name: string): ChannelMeta => ({
  chatId,
  title: '',
  isGroup: false,
  members: [
    { userId: SELF, name: '나' },
    { userId: otherId, name }
  ],
  raw: {}
});

test('loadLoginList keeps LOGINLIST chats and re-adds remembered ones', () => {
  const { reg, knownChats, store, done } = setup();
  knownChats.remember({ id: 'old', type: 'DirectChat', title: 'Old' });
  store.saveMessage({ seq: 0, chatId: 'old', messageId: '5', authorId: '2', text: 'photo', type: 2, sendAt: 50 });
  const r = reg.loadLoginList([
    { id: 'a', type: 'MultiChat', unreadCount: 3, lastMessage: 'hi', lastMessageType: 1, lastSendAt: 100, memberCount: 5, raw: { l: { logId: 77 } } }
  ]);
  assert.deepEqual(r, { fromLoginList: 1, remembered: 1 });
  assert.equal(reg.get('a')?.maxLogId, '77');
  assert.equal(reg.get('old')?.lastMessage, '[사진]');
  assert.deepEqual(knownChats.list().map((k) => k.id).sort(), ['a', 'old']);
  done();
});

test('list sorts by recent activity and filters direct/group', () => {
  const { reg, done } = setup();
  reg.loadLoginList([
    { id: 'g', type: 'MultiChat', lastSendAt: 10 },
    { id: 'd', type: 'DirectChat', lastSendAt: 30, memberCount: 2 },
    { id: 'memo', type: 'MemoChat', lastSendAt: 20 },
    { id: 'o', type: 'OM', lastSendAt: 5 }
  ]);
  assert.deepEqual(reg.list().map((c) => c.id), ['d', 'memo', 'g', 'o']);
  assert.deepEqual(reg.list('direct').map((c) => c.id), ['d']);
  assert.deepEqual(reg.list('group').map((c) => c.id), ['g', 'o']);
  done();
});

test('noteMessage tracks unread and registers unknown chats', () => {
  const { reg, knownChats, done } = setup();
  reg.loadLoginList([{ id: 'd', type: 'DirectChat', lastSendAt: 1, unreadCount: 0 }]);
  assert.equal(reg.noteMessage({ chatId: 'd', authorId: '2', messageId: '10', text: 'a', type: 1, sendAt: 2, raw: {} }), false);
  reg.noteMessage({ chatId: 'd', authorId: '2', messageId: '11', text: 'b', type: 1, sendAt: 3, raw: {} });
  assert.equal(reg.get('d')?.unreadCount, 2);
  assert.equal(reg.get('d')?.maxLogId, '11');
  reg.noteMessage({ chatId: 'd', authorId: SELF, messageId: '12', text: 'me', type: 1, sendAt: 4, raw: {} });
  assert.equal(reg.get('d')?.unreadCount, 0);

  assert.equal(reg.noteMessage({ chatId: 'new', authorId: '3', messageId: '1', text: '{"type":"bye"}', type: 51, sendAt: 5, raw: {} }), true);
  assert.equal(reg.get('new')?.lastMessage, '[통화 종료]');
  assert.ok(knownChats.list().some((k) => k.id === 'new'));

  reg.noteMessage({ chatId: 'd', authorId: '2', messageId: '13', text: 'c', type: 1, sendAt: 6, raw: {} });
  reg.markReadUpTo('d', '12');
  assert.equal(reg.get('d')?.unreadCount, 1, 'watermark below newest keeps unread');
  reg.markReadUpTo('d', '13');
  assert.equal(reg.get('d')?.unreadCount, 0);
  done();
});

test('getInfo enriches names, titles 1:1 chats, caches, and remembers', async () => {
  // Friends must exist before FriendsStore loads, so build a registry over a pre-seeded DB.
  const { db, knownChats, fetched, done } = setup();
  db.db.prepare('INSERT INTO friends (user_id, data) VALUES (?, ?)').run('2', JSON.stringify({ userId: '2', nickName: '길동', friendNickName: '길동 친구' }));
  const enriched = new ChatRegistry({
    knownChats,
    store: new MessageStore(db),
    friends: new FriendsStore(db),
    selfUserId: () => SELF,
    fetchMeta: async () => {
      fetched.push('d');
      return direct('d', '2', '길동');
    },
    log: () => {}
  });
  enriched.loadLoginList([{ id: 'd', type: '' }]);
  const meta = await enriched.getInfo('d');
  assert.equal(meta.title, '길동 친구');
  assert.equal(enriched.get('d')?.type, 'DirectChat');
  assert.equal(enriched.authorName('d', '2'), '길동 친구');
  await enriched.getInfo('d');
  assert.equal(fetched.length, 1, 'second call is served from cache');
  assert.deepEqual(knownChats.list().find((k) => k.id === 'd'), { id: 'd', type: 'DirectChat', title: '길동 친구' });
  done();
});

test('findDirectChatWith checks cache, then fetches, skipping unreadable chats', async () => {
  const { reg, fetched, logs, done } = setup({ d2: direct('d2', '9', '대상') });
  reg.loadLoginList([
    { id: 'broken', type: 'DirectChat' },
    { id: 'd2', type: 'DirectChat' },
    { id: 'g', type: 'MultiChat' }
  ]);
  assert.deepEqual(await reg.findDirectChatWith('9'), { chatId: 'd2', title: '대상' });
  assert.ok(logs.some((l) => l.includes('room metadata unavailable: INTERNAL')));
  assert.equal(logs.join('\n').includes('broken'), false);
  assert.ok(!fetched.includes('g'), 'group chats are not fetched');
  const before = fetched.length;
  assert.deepEqual(await reg.findDirectChatWith('9'), { chatId: 'd2', title: '대상' });
  assert.equal(fetched.filter((x) => x === 'd2').length, 1, 'cached on the second lookup');
  assert.ok(fetched.length >= before);
  assert.equal(await reg.findDirectChatWith('404'), undefined);
  done();
});

test('type code decides group-ness: 2-member MultiChat stays a group, OM is a group', async () => {
  const two: ChannelMeta = { chatId: 'm', title: '', isGroup: false, members: [{ userId: SELF, name: '나' }, { userId: '2', name: '길동' }], raw: {} };
  const { reg, done } = setup({ m: two });
  reg.loadLoginList([
    { id: 'm', type: 'MultiChat', memberCount: 2, lastSendAt: 3 },
    { id: 'om', type: 'OM', memberCount: 2, lastSendAt: 2 },
    { id: 'p', type: 'PlusChat', memberCount: 2, lastSendAt: 1 }
  ]);
  assert.deepEqual(reg.list('group').map((c) => c.id), ['m', 'om']);
  assert.deepEqual(reg.list('direct').map((c) => c.id), ['p']);
  const meta = await reg.getInfo('m');
  assert.equal(meta.isGroup, true);
  assert.equal(reg.get('m')?.isGroup, true);
  done();
});

test('a memo chat first seen from a pushed message keeps the server type, not a guessed DirectChat', async () => {
  const memo: ChannelMeta = { chatId: 'me', title: '', isGroup: false, type: 'MemoChat', members: [{ userId: SELF, name: '나' }], raw: {} };
  const { reg, knownChats, done } = setup({ me: memo });
  reg.loadLoginList([]);
  assert.equal(reg.noteMessage({ chatId: 'me', messageId: '9', authorId: SELF, text: 'memo', type: 1, sendAt: 5, raw: {} }), true);
  await reg.getInfo('me');
  assert.equal(reg.get('me')?.type, 'MemoChat');
  assert.equal(reg.get('me')?.title, '나와의 채팅');
  assert.ok(knownChats.list().some((k) => k.id === 'me' && k.type === 'MemoChat'));
  assert.equal(reg.rememberExisting({ ...memo, chatId: 'me2' }).type, 'MemoChat');
  done();
});

test('addCreatedDirectChat and remove', () => {
  const { reg, knownChats, done } = setup();
  reg.addCreatedDirectChat('c', '길동');
  assert.equal(reg.get('c')?.title, '길동');
  assert.ok(knownChats.list().some((k) => k.id === 'c' && k.type === 'DirectChat'));
  reg.remove('c');
  assert.equal(reg.get('c'), undefined);
  done();
});

test('resolveAuthors names authors the chat metadata does not list, asking MEMBER once per author', async () => {
  const group: ChannelMeta = { chatId: 'g', title: 'G', isGroup: true, members: [{ userId: SELF, name: '나' }, { userId: '2', name: '홍길동' }], raw: {} };
  const asked: string[][] = [];
  let fail = true;
  const { reg, logs, done } = setup({ g: group }, async (_chatId, ids) => {
    asked.push(ids);
    if (fail) {
      fail = false;
      throw new Error('session not connected');
    }
    // '5' left the chat: the server returns no member for it.
    return ids.filter((id) => id !== '5').map((id) => ({ userId: id, name: `멤버${id}` }));
  });

  // A failed request is forgotten, so the next call asks again.
  assert.equal(await reg.resolveAuthors('g', ['3', '4']), 0);
  assert.match(logs.join('\n'), /MEMBER for 2 failed/);
  assert.equal(await reg.resolveAuthors('g', ['2', '3', '4', '4', '5', undefined]), 2);
  assert.deepEqual(asked[1], ['3', '4', '5'], 'listed members (2) and duplicates are not asked for');
  assert.equal(reg.authorName('g', '2'), '홍길동');
  assert.equal(reg.authorName('g', '3'), '멤버3');
  assert.equal(reg.authorName('g', '5'), undefined);

  // Already asked (named or not): no new request.
  assert.equal(await reg.resolveAuthors('g', ['3', '5']), 0);
  assert.equal(asked.length, 2);
  done();
});

test('resolveAuthors batches MEMBER requests at 100 userIds', async () => {
  const group: ChannelMeta = { chatId: 'g', title: 'G', isGroup: true, members: [], raw: {} };
  const sizes: number[] = [];
  const { reg, done } = setup({ g: group }, async (_chatId, ids) => {
    sizes.push(ids.length);
    return ids.map((id) => ({ userId: id, name: `n${id}` }));
  });
  const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
  assert.equal(await reg.resolveAuthors('g', ids), 250);
  assert.deepEqual(sizes, [100, 100, 50]);
  done();
});

test('remembering a resolved archive room adds it locally, survives reload and does not invent unread counts', () => {
  const meta: ChannelMeta = { chatId: '123456789', title: 'synthetic group', isGroup: true,
    members: [{ userId: SELF, name: '나' }, { userId: '2', name: '홍길동' }], raw: {}, lastLogId: '100' };
  const { reg, knownChats, done } = setup({ '123456789': meta });
  try {
    const room = reg.rememberExisting(meta);
    assert.equal(room.title, 'synthetic group'); assert.equal(room.unreadCount, null);
    assert.equal(knownChats.list().length, 1);
    reg.noteMessage({ chatId: room.id, messageId: '101', authorId: '2', text: 'synthetic', sendAt: 1, raw: {} });
    assert.equal(reg.get(room.id)?.unreadCount, null);
    reg.loadLoginList([]);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.rememberExisting(meta).maxLogId, '101', 'does not overwrite a known room with old archive state');
    reg.remove(room.id);
    reg.loadLoginList([]);
    assert.equal(reg.get(room.id)?.title, 'synthetic group');
    assert.equal(reg.get(room.id)?.unreadCount, null);
  } finally { done(); }
});


test('missing LOGINLIST unread count stays unknown until the server confirms it', () => {
  const { reg, done } = setup();
  reg.loadLoginList([{ id: 'd', type: 'DirectChat' }]);
  assert.equal(reg.get('d')?.unreadCount, null);
  reg.noteMessage({ chatId: 'd', authorId: '2', messageId: '10', text: 'fixture', type: 1, sendAt: 2, raw: {} });
  assert.equal(reg.get('d')?.unreadCount, null);
  reg.setUnread('d', 0);
  assert.equal(reg.get('d')?.unreadCount, 0);
  done();
});

test('explicit title refresh and reconnect update names instead of retaining metadata forever', async () => {
  const metas: Record<string, ChannelMeta> = { '123': { chatId: '123', title: '처음 방', titleSource: 'shared', isGroup: true, members: [], raw: {} } };
  const f = setup(metas);
  try {
    f.reg.loadLoginList([{ id: '123', type: 'MultiChat' }]);
    assert.equal((await f.reg.getInfo('123')).title, '처음 방');
    metas['123'].title = '수정한 방';
    assert.equal((await f.reg.getInfo('123')).title, '처음 방');
    assert.equal((await f.reg.getInfo('123', true)).title, '수정한 방');
    metas['123'].title = '재연결한 방';
    f.reg.loadLoginList([{ id: '123', type: 'MultiChat' }]);
    assert.equal((await f.reg.getInfo('123')).title, '재연결한 방');
    assert.equal(f.reg.list()[0].titleSource, 'shared');
  } finally { f.done(); }
});
