import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KakaoError } from '@kakao-max/core';
import { findChatCandidates, registerChatDiscoveryTools } from './tools/chat-discovery.ts';

test('find_chat identifies rooms by participants/count without reading contents or creating rooms', async () => {
  const calls: string[] = [];
  const kakao = {
    listChats: () => [
      { id: '123456789', title: 'fixture group', type: 'OM', memberCount: 35, unreadCount: 31 },
      { id: '987654321', title: 'fixture pair', type: 'MultiChat', memberCount: 2, unreadCount: 0 }
    ],
    getChatInfo: async (id: string) => { calls.push(id); return { chatId: id, title: 'fixture pair', isGroup: true,
      members: [{ userId: '111111111', name: '홍길동' }, { userId: '222222222', name: '김철수' }] }; }
  };
  const result = await findChatCandidates(kakao as never, { participants: ['김철수'], memberCount: 2 });
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].chatId, '987654321');
  assert.equal(result.matches[0].matchedBy, 'participants'); assert.equal(result.ambiguous, false);
  assert.deepEqual(calls, ['987654321']);
  let tool: any;
  registerChatDiscoveryTools({ registerTool: (t: unknown) => { tool = t; } } as never, kakao as never);
  assert.equal((await tool.handler({ memberCount: 35 })).untrusted, true);
});

test('find_chat reports ambiguity and bounded/incomplete search instead of selecting first candidate', async () => {
  const kakao = { listChats: () => Array.from({ length: 12 }, (_, n) => ({ id: String(n + 1), title: 'fixture', memberCount: 2 })),
    getChatInfo: async (id: string) => ({ chatId: id, title: 'fixture', members: [], isGroup: true }) };
  const result = await findChatCandidates(kakao as never, { query: 'fixture' });
  assert.equal(result.matches.length, 10); assert.equal(result.ambiguous, true); assert.equal(result.incomplete, true);
  await assert.rejects(findChatCandidates(kakao as never, {}), { code: 'INVALID_ARGUMENT' });
  kakao.getChatInfo = async () => { throw new KakaoError('NETWORK', 'fixture metadata unavailable'); };
  await assert.rejects(findChatCandidates(kakao as never, { query: 'fixture' }), { code: 'NETWORK' });
});

test('a cold-start room after page ten is discoverable and cursors bind the search', async () => {
  const kakao = { listChats: () => Array.from({ length: 12 }, (_, n) => ({ id: String(n + 10), title: undefined, memberCount: 2 })),
    getChatInfo: async (id: string) => ({ chatId: id, title: id === '21' ? 'Ｆｉｘｔｕｒｅ—방' : 'other', members: [{ name: '홍 길동' }], isGroup: true }) };
  const first = await findChatCandidates(kakao as never, { query: 'fixture 방', participants: ['홍길동'] });
  assert.equal(first.matches.length, 0); assert.ok(first.nextCursor);
  const second = await findChatCandidates(kakao as never, { query: 'fixture 방', participants: ['홍길동'], cursor: first.nextCursor! });
  assert.equal(second.matches[0].chatId, '21'); assert.equal(second.nextCursor, null);
  await assert.rejects(findChatCandidates(kakao as never, { query: 'other', cursor: first.nextCursor! }), { code: 'CURSOR_CONFLICT' });
  const wrongPerson = await findChatCandidates(kakao as never, { query: 'other', participants: ['김철수'] });
  assert.equal(wrongPerson.matches.length, 0);
});

test('resolved titles avoid hydrating unrelated rooms while still proving uniqueness across the loaded list', async () => {
  const calls: string[] = [];
  const kakao = { listChats: () => Array.from({ length: 50 }, (_, n) => ({ id: String(n + 10), title: n === 49 ? '프로젝트 방' : '다른 방', titleSource: 'shared', memberCount: 2 })),
    getChatInfo: async (id: string) => { calls.push(id); return { chatId: id, title: '프로젝트 방', members: [], isGroup: true }; } };
  const result = await findChatCandidates(kakao as never, { query: '프로젝트방' });
  assert.equal(result.matches.length, 1); assert.equal(result.incomplete, false); assert.equal(result.ambiguous, false);
  assert.equal(result.searched, 50); assert.equal(result.metadataFetched, 1); assert.deepEqual(calls, ['59']);
});

test('a member-count search checks rooms whose count is not known yet instead of dropping them', async () => {
  const kakao = {
    listChats: () => [{ id: '111111111', type: 'MemoChat', unreadCount: 0 }, { id: '222222222', type: 'MultiChat', memberCount: 3, unreadCount: 0 },
      { id: '333333333', type: 'DirectChat', unreadCount: 0 }],
    getChatInfo: async (id: string) => ({ chatId: id, title: id === '111111111' ? '나와의 채팅' : 'fixture pair', titleSource: 'participants', isGroup: false,
      members: id === '111111111' ? [{ userId: '9', name: '나' }] : [{ userId: '9', name: '나' }, { userId: '8', name: '홍길동' }] })
  };
  const result = await findChatCandidates(kakao as never, { memberCount: 1 });
  assert.deepEqual(result.matches.map(m => [m.chatId, m.memberCount, m.title]), [['111111111', 1, '나와의 채팅']]);
  assert.equal(result.searched, 2, 'the known 3-member room is skipped, both unknown rooms are checked');
});
