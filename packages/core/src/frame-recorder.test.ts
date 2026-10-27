import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSanitizer } from './frame-recorder.ts';

const secret = Buffer.alloc(32, 7);

test('strings are replaced except chat-type enums (numeric strings too)', () => {
  const s = createSanitizer(secret, 1000n, 86_400);
  assert.deepEqual(s({ message: '안녕하세요 홍길동님', t: 'DirectChat', o: 'OM', nickName: 'LOL', oauthToken: 'abc.def' }), {
    message: 's:10',
    t: 'DirectChat',
    o: 'OM',
    nickName: 's:3',
    oauthToken: 's:7'
  });
  assert.equal(s('01012345678', 'phone'), 's:11');
});

test('log ids are shifted (order kept); other ids are consistently hashed', () => {
  const s = createSanitizer(secret, 1000n, 86_400);
  const a = s({ logId: 3950000000000000123n, authorId: 123456789, chatId: 123456789 }) as any;
  const b = s({ logId: 3950000000000000124n, userId: 123456789 }) as any;
  assert.equal(a.logId, '3949999999999999123');
  assert.ok(BigInt(b.logId) > BigInt(a.logId));
  assert.equal(a.authorId, a.chatId, 'same id → same fake within one recording');
  assert.equal(a.authorId, b.userId);
  assert.notEqual(a.authorId, '123456789');
  assert.equal(a.authorId.length, 9);
});

test('timestamps shift by whole days; small numbers and flags stay', () => {
  const s = createSanitizer(secret, 1000n, 2 * 86_400);
  assert.deepEqual(s({ sendAt: 1792366975, type: 1, status: 0, u: 61, eof: true, a: null }), {
    sendAt: 1792366975 - 2 * 86_400,
    type: 1,
    status: 0,
    u: 61,
    eof: true,
    a: null
  });
});

test('numeric object keys, nested arrays and binary are sanitized', () => {
  const s = createSanitizer(secret, 1000n, 86_400);
  const out = s({ members: { '123456789': { nickName: 'x' } }, chatDatas: [{ c: 10000000000000001, l: { logId: 5000000n } }], img: new Uint8Array([1]) }) as any;
  assert.ok(!('123456789' in out.members));
  assert.equal(Object.keys(out.members)[0].length, 9);
  assert.notEqual(out.chatDatas[0].c, '10000000000000001');
  assert.equal(out.chatDatas[0].l.logId, '4999000');
  assert.equal(out.img, 'bin');
});

test('id-named keys are hashed even when the id is short', () => {
  const s = createSanitizer(secret, 1000n, 86_400);
  const out = s({ userId: 713001, inviterId: 713001, i: [713001, 12], members: [{ userId: 42 }], type: 1, status: -950 }) as any;
  assert.notEqual(String(out.userId), '713001');
  assert.equal(out.userId, out.inviterId);
  assert.equal(out.i[0], out.userId);
  assert.notEqual(String(out.i[1]), '12');
  assert.notEqual(String(out.members[0].userId), '42');
  assert.equal(out.type, 1);
  assert.equal(out.status, -950);
});

test('log-id sentinels stay; msgId is hashed, not shifted', () => {
  const s = createSanitizer(secret, 1000n, 86_400);
  const out = s({ cur: 0, max: 0, lastTokenId: 0, msgId: 123456789 }) as any;
  assert.deepEqual([out.cur, out.max, out.lastTokenId], [0, 0, 0]);
  assert.notEqual(String(out.msgId), '123456789');
  assert.ok(!String(out.msgId).startsWith('-'));
});

test('different secrets give different fakes', () => {
  const a = createSanitizer(Buffer.alloc(32, 1))({ userId: 123456789 }) as any;
  const b = createSanitizer(Buffer.alloc(32, 2))({ userId: 123456789 }) as any;
  assert.notEqual(a.userId, b.userId);
});
