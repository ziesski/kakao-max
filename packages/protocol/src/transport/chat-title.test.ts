import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocoSession } from './loco-session.js';
import { parseChannelMeta } from './loco-parse.js';

test('custom room names survive JSON strings and decoded objects', () => {
  for (const mcMetas of ['{"name":"프로젝트 방"}', { name: '프로젝트 방' }]) {
    const meta = parseChannelMeta('123', { members: [{ userId: '1', nickName: '홍길동' }] }, { chatInfo: { mcMetas } });
    assert.equal(meta.title, '프로젝트 방');
    assert.equal(meta.titleSource, 'custom');
  }
});

test('shared title metadata takes precedence over participant fallback', () => {
  const meta = parseChannelMeta('123', { members: [{ userId: '1', nickName: '홍길동' }] }, {
    chatInfo: { type: 'OM', mcMetas: null, chatMetas: [
      { type: 1, content: '{"name":"notice must not become a title"}' },
      { type: 14, content: '{"name":"bot is not a title"}' },
      { type: 3, content: '프로젝트 오픈채팅' }
    ] }
  });
  assert.equal(meta.title, '프로젝트 오픈채팅');
  assert.equal(meta.titleSource, 'shared');
});

test('invalid or absent titles remain an explicitly identified fallback', () => {
  for (const content of ['not-json', '{"name":123}', '{"name":" "}', '{"message":"private content"}']) {
    const meta = parseChannelMeta('123', { members: [{ userId: '1', nickName: '홍길동' }] }, {
      chatInfo: { type: 'OM', mcMetas: '{', chatMetas: [{ type: 14, content }] }
    });
    assert.equal(meta.title, '홍길동');
    assert.equal(meta.titleSource, 'participants');
  }
});

test('open-link fallback requests and matches only the existing room link', async () => {
  const session = new LocoSession();
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return { header: { status: 0 }, data: method === 'CHATINFO' ? { chatInfo: { type: 'OM', li: '456' } } :
      method === 'GETMEM' ? { members: [] } : { ols: [{ li: '999', ln: 'wrong room' }, { li: '456', ln: '프로젝트 방' }] } };
  };
  const meta = await session.getChannelMeta('123');
  assert.equal(meta.title, '프로젝트 방');
  assert.equal(meta.titleSource, 'open_chat');
  assert.deepEqual(calls.map(c => c.method), ['GETMEM', 'CHATINFO', 'INFOLINK']);
  assert.equal(calls[2].body.lis.length, 1);
  assert.equal(String(calls[2].body.lis[0]), '456');
});

test('open-link errors propagate and unrelated links never become this room title', async () => {
  for (const status of [0, -1]) {
    const session = new LocoSession();
    (session as any).request = async (method: string) => ({ header: { status: 0 }, data:
      method === 'CHATINFO' ? { chatInfo: { type: 'OM', li: '456' } } :
      method === 'GETMEM' ? { members: [] } : { status, ols: [{ li: '999', ln: 'wrong room' }] } });
    if (status) await assert.rejects(session.getChannelMeta('123'), /INFOLINK failed/);
    else assert.equal((await session.getChannelMeta('123')).titleSource, 'participants');
  }
});

test('CHATINFO type is kept so a memo chat is not guessed from its single member', () => {
  assert.equal(parseChannelMeta('7', { members: [{ userId: '1', nickName: '나' }] }, { chatInfo: { type: 'MemoChat' } }, '1').type, 'MemoChat');
  assert.equal(parseChannelMeta('7', { members: [] }, null).type, undefined);
});
