import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { removeTestDir } from './temp-dir.test-helper.ts';
import os from 'node:os';
import path from 'node:path';
import { Long, type ResilientLocoSession } from '@kakao-max/protocol';
import { KakaoSession } from './kakao-session.ts';
import { KakaoDb } from './db.ts';
import { MessageStore } from './message-store.ts';
import { KakaoError } from './errors.ts';
import { loadConfig } from './config.ts';


import { SELF, BSON_LONG, CHAT, FakeLocoSession, phoneRead, readRecent, readSearch, readHistory, readWait, setup, isCode } from './kakao-session-fixture.test-helper.ts';

test('session and metadata diagnostics omit identifiers, content, paths and upstream failures', async t => {
  const logs: string[] = [];
  const { kakao, fake, dir } = setup({}, [], true, line => logs.push(line));
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.getChannelMeta = async () => { throw new Error('fixture-private-provider-body'); };
  fake.connect();
  fake.emit('read', { chatId: CHAT, userId: SELF, watermark: '9007199254740993' });
  fake.emit('error', new Error('fixture-private-provider-body'));
  fake.emit('syncmodmsg', { chatLog: { chatId: CHAT, messageId: '9007199254740993' } });
  fake.emit('syncdlmsg', { chatLog: { chatId: CHAT, messageId: '9007199254740994', type: 0, text: '{"feedType":14,"logId":"9007199254740993"}' } });
  fake.emit('packet', { header: { method: 'SYNCACTION', id: 17, status: 0 }, data: { 'fixture-private-key': 'fixture-private-value', chatId: CHAT } });
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9007199254740995',
    type: 1, text: 'fixture-private-message', raw: {} });
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  const text = logs.join('\n');
  assert.match(text, /message received/); assert.match(text, /session error: INTERNAL/);
  for (const privateValue of [SELF, CHAT, '9007199254740993', 'fixture-private', dir]) {
    assert.equal(text.includes(privateValue), false, 'diagnostics must not contain private fixture fields');
  }
});

test('a message or connect event that fails to store is logged by code and does not escape into the LOCO reader', async t => {
  const logs: string[] = [];
  const { kakao, fake, stored, dir } = setup({}, [], true, line => logs.push(line));
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.connect();
  // Not a canonical message id: the inbox refuses it.
  assert.doesNotThrow(() => fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: 'fixture-bad-id', type: 1, text: 'fixture-private-message', sendAt: 1, raw: {} }));
  assert.doesNotThrow(() => fake.emit('connected', { endpoint: { host: 'loco.test', port: 443 }, loginList: { raw: {} } }));
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9007199254740995', type: 1, text: 'after', sendAt: 2, raw: {} });
  assert.deepEqual(stored().map(m => m.messageId), ['9007199254740995'], 'the next message is still recorded');
  const text = logs.join('\n');
  assert.match(text, /message event handling failed: [A-Z_]+/);
  assert.match(text, /connected event handling failed: [A-Z_]+/);
  for (const privateValue of ['fixture-bad-id', 'fixture-private', CHAT, SELF]) assert.equal(text.includes(privateValue), false);
});

test('LOCO calls fail fast with NOT_CONNECTED until connected, and again while reconnecting', async () => {
  const { kakao, fake } = setup();
  await assert.rejects(kakao.sendMessage(CHAT, 'hi'), isCode('NOT_CONNECTED'));
  await assert.rejects(kakao.markRead(CHAT, '1'), isCode('NOT_CONNECTED'));
  assert.equal(fake.calls.length, 0, 'nothing reaches the LOCO session while disconnected');

  fake.connect();
  assert.equal(kakao.getState().connected, true);
  fake.replies.sendText = [{ status: 0, logId: '1001', raw: {} }];
  await kakao.sendMessage(CHAT, 'hi');
  assert.equal(fake.calls.length, 1);

  fake.emit('reconnecting', { attempt: 1, delayMs: 1000 });
  await assert.rejects(kakao.sendMessage(CHAT, 'hi'), isCode('NOT_CONNECTED'));
  assert.equal(fake.calls.length, 1);
});

test('a sent message is recorded from the server echo, falling back to what was sent', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.replies.sendReply = [
    {
      status: 0,
      logId: '2001',
      raw: { chatLog: { type: 26, message: 'echoed reply', attachment: { src_logId: '1999' }, sendAt: 1_700_000_000 } }
    }
  ];
  fake.replies.sendText = [
    { status: 0, logId: '2002', raw: {} },
    { status: 0, raw: {} }, // no logId: nothing to record
    // The echo's type wins even when it differs from the method's fallback (1 for plain text).
    { status: 0, logId: '2003', raw: { chatLog: { type: 26, message: 'server view' } } }
  ];

  await kakao.sendReply(CHAT, 'asked text', { logId: '1999', userId: SELF });
  await kakao.sendMessage(CHAT, 'plain text');
  await kakao.sendMessage(CHAT, 'unlogged');
  await kakao.sendMessage(CHAT, 'local view');

  const byId = new Map(stored().map((m) => [m.messageId, m]));
  assert.equal(byId.size, 3);
  assert.equal(byId.get('2003')!.type, 26);
  assert.equal(byId.get('2003')!.text, 'server view');
  const reply = byId.get('2001')!;
  assert.equal(reply.type, 26, 'type comes from the echo, not the fallback');
  assert.equal(reply.text, 'echoed reply');
  assert.equal(reply.authorId, SELF);
  assert.equal(reply.sendAt, 1_700_000_000);
  assert.deepEqual(JSON.parse(reply.attachment!), { src_logId: '1999' });
  const plain = byId.get('2002')!;
  assert.equal(plain.type, 1);
  assert.equal(plain.text, 'plain text');
  assert.equal((await readRecent(kakao, 0, CHAT)).length, 3, 'sent messages also reach the feed');
});

test('a failed WRITE throws LOCO_STATUS and records nothing', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.replies.sendText = [{ status: -500, logId: '3001', raw: {} }];
  await assert.rejects(kakao.sendMessage(CHAT, 'x'), (e: unknown) => isCode('LOCO_STATUS')(e) && (e as KakaoError).details?.status === -500);
  assert.equal(stored().length, 0);
});

test('an uploaded photo is recorded from the server chatLog; a failed upload is not', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  const attachment = { k: 'fake-key', cs: 'fake-checksum', w: 10, h: 10 };
  fake.replies.uploadMedia = [
    { status: 0, chatLog: { logId: '4001', chatId: CHAT, type: 2, message: '', attachment, sendAt: 1_700_000_100 }, raw: {} },
    { status: -1, chatLog: { logId: '4002', chatId: CHAT, type: 2 }, raw: {} }
  ];

  await kakao.uploadMedia(CHAT, { data: new Uint8Array([1, 2, 3]), type: 2 });
  await kakao.uploadMedia(CHAT, { data: new Uint8Array([1, 2, 3]), type: 2 });

  const upload = fake.calls.find((c) => c.method === 'uploadMedia')!;
  assert.equal((upload.args[1] as { userId: string }).userId, SELF, 'the upload is made as the account user');
  const msgs = stored();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].messageId, '4001');
  assert.equal(msgs[0].type, 2);
  assert.equal(msgs[0].authorId, SELF);
  assert.deepEqual(JSON.parse(msgs[0].attachment!), attachment);
});

test('an author the group metadata does not list is looked up with MEMBER and named on later reads', async () => {
  const { kakao, fake } = setup();
  fake.meta = { title: '큰 방', isGroup: true, members: [{ userId: SELF, name: '나' }] };
  fake.replies.getMembers = [{ status: 0, members: [{ userId: '555', name: '홍길동' }], raw: {} }];
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '555', messageId: '5001', type: 1, text: 'hello', sendAt: 1_700_000_200, raw: {} });
  // The lookup runs in the background; wait (bounded) until the name is known.
  for (let i = 0; i < 50 && !(await readRecent(kakao, 0, CHAT))[0]?.authorName; i++) await new Promise((r) => setImmediate(r));

  const lookup = fake.calls.find((c) => c.method === 'getMembers')!;
  assert.deepEqual(lookup.args, [CHAT, ['555']]);
  assert.equal((await readRecent(kakao, 0, CHAT))[0].authorName, '홍길동');
  assert.equal((await readSearch(kakao, 'hello', { chatId: CHAT }))[0].authorName, '홍길동');
});

test('hideMessages hides locally without any LOCO call, even while disconnected', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.replies.sendText = [
    { status: 0, logId: '3001', raw: {} },
    { status: 0, logId: '3002', raw: {} }
  ];
  await kakao.sendMessage(CHAT, 'first');
  await kakao.sendMessage(CHAT, 'second');
  const callsBefore = fake.calls.length;

  fake.emit('reconnecting', { attempt: 1, delayMs: 1000 });
  const res = kakao.hideMessages(CHAT, ['3002']);
  assert.deepEqual(res, { hidden: ['3002'], alreadyHidden: [], notStored: [] });
  assert.equal(fake.calls.length, callsBefore, 'nothing is sent to the server');
  assert.deepEqual(stored().map((m) => m.messageId), ['3001']);
  assert.deepEqual((await readRecent(kakao, 0, CHAT)).map((m) => m.messageId), ['3001'], 'the feed drops it too');
  assert.deepEqual((await (await readWait(kakao, 0, 10, CHAT))).map((m) => m.messageId), ['3001']);
});

test('getBlockList reads the address book, never sends BLSYNC, and resolves profiles with BLMEMBER', async () => {
  const { kakao, fake } = setup({}, [
    { userId: '8888', nickName: '홍길동', type: 9 },
    { userId: '7777', nickName: '김철수', type: 1 }
  ]);
  fake.connect();
  fake.replies.getBlockMembers = [
    {
      status: 0,
      members: [{ userId: '8888', name: '차단사용자', profileImageUrl: 'http://pic.jpg' }],
      blockTypes: [2],
      raw: {}
    }
  ];
  const list = await kakao.getBlockList();
  assert.equal(fake.calls.some((c) => c.method === 'syncBlockList'), false);
  assert.deepEqual(fake.calls.find((c) => c.method === 'getBlockMembers')?.args, [['8888']]);
  assert.deepEqual(list.blockIds, ['8888']);
  assert.deepEqual(list.blockTypes, [2]);
  assert.equal(list.members?.[0].name, '차단사용자');
});

test('blockUser and unblockUser invoke addBlockItem and deleteBlockItem on LOCO session', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  fake.replies.addBlockItem = [{ status: 0, raw: {} }];
  fake.replies.deleteBlockItem = [{ status: 0, raw: {} }];

  await kakao.blockUser('8888', 2);
  const blockCall = fake.calls.find((c) => c.method === 'addBlockItem');
  assert.deepEqual(blockCall?.args, [['8888'], [2]]);

  await kakao.unblockUser('8888');
  const unblockCall = fake.calls.find((c) => c.method === 'deleteBlockItem');
  assert.deepEqual(unblockCall?.args, [['8888']]);
});

test('editMessage sends MODIFYMSG and updates the stored text only on status 0', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.replies.sendText = [{ status: 0, logId: '5001', raw: {} }];
  await kakao.sendMessage(CHAT, 'before');
  fake.replies.modifyMessage = [{ status: -500, raw: {} }, { status: 0, raw: {} }];
  await assert.rejects(kakao.editMessage(CHAT, '5001', 'after'), isCode('LOCO_STATUS'));
  assert.equal(stored().find((m) => m.messageId === '5001')?.text, 'before');
  await kakao.editMessage(CHAT, '5001', 'after');
  assert.deepEqual(fake.calls.at(-1)?.args, [CHAT, '5001', 'after']);
  assert.equal(stored().find((m) => m.messageId === '5001')?.text, 'after');
});

test('sendEmoticonFrom re-sends a stored emoticon unchanged and refuses anything else', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  // Shape of a live type 20 attachment (2026-10-19); values made up.
  const attachment = JSON.stringify({ alt: '(이모티콘)', emoticonItemPath: 'a/b.webp', kid: [1], name: '(이모티콘)', path: '4412207.emot_001.webp' });
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '6001', type: 20, text: '', attachment, sendAt: 1, raw: {} });
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '6002', type: 1, text: 'hi', sendAt: 2, raw: {} });

  phoneRead(kakao);
  await assert.rejects(kakao.sendEmoticonFrom(CHAT, { chatId: CHAT, logId: '6002' }), isCode('INVALID_ARGUMENT'));
  await assert.rejects(kakao.sendEmoticonFrom(CHAT, { chatId: CHAT, logId: '9999' }), isCode('NOT_FOUND'));

  fake.replies.sendEmoticonRaw = [{ status: 0, logId: '6003', raw: {} }];
  await kakao.sendEmoticonFrom(CHAT, { chatId: CHAT, logId: '6001' });
  assert.deepEqual(fake.calls.at(-1)?.args, [CHAT, { type: 20, extra: attachment, text: '' }]);
});

test('sendEmoticon sends WRITE with type, extra and text and registers in store', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.replies.sendEmoticonRaw = [{ status: 0, logId: '6004', raw: {} }];
  const em = { name: '(미소)', path: '4412207.emot_001.webp', alt: '(미소)' };
  const res = await kakao.sendEmoticon(CHAT, { emoticon: em, type: 20 });
  assert.equal(res.status, 0);
  assert.equal(res.logId, '6004');
  assert.equal(fake.calls.at(-1)?.method, 'sendEmoticonRaw');
  const [chatIdArg, optsArg] = fake.calls.at(-1)?.args as any;
  assert.equal(chatIdArg, CHAT);
  assert.equal(optsArg.type, 20);
  assert.equal(optsArg.text, '(미소)');
  const parsed = JSON.parse(optsArg.extra);
  assert.equal(parsed.name, '(미소)');
  assert.equal(parsed.path, '4412207.emot_001.webp');
  assert.equal(stored().find(m => m.messageId === '6004')?.text, '(미소)');
});

test('deleteMessage and syncdlmsg push mark message deleted in store', async () => {
  const { kakao, fake, stored } = setup();
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '7001', type: 1, text: 'msg 1', sendAt: 1, raw: {} });
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '7002', type: 1, text: 'msg 2', sendAt: 2, raw: {} });

  assert.equal(stored().length, 2);

  // syncdlmsg push from another device: its chatLog is a feed notice pointing at the deleted message
  fake.emit('syncdlmsg', { chatLog: { chatId: CHAT, authorId: '42', messageId: '7003', type: 0, text: JSON.stringify({ logId: 7001, feedType: 14 }), sendAt: 3, raw: {} } });
  assert.deepEqual(stored().map((m) => m.messageId), ['7002', '7003']);
  assert.deepEqual((await readRecent(kakao, 0, CHAT)).map((m) => m.messageId), ['7002', '7003']);

  // deleteMessage call
  fake.replies.deleteMessage = [{ status: 0, raw: {} }];
  await kakao.deleteMessage(CHAT, '7002');
  assert.deepEqual(stored().map((m) => m.messageId), ['7003']);
  assert.deepEqual((await readRecent(kakao, 0, CHAT)).map((m) => m.messageId), ['7003']);
});



test('a history backfill treats only messages newer than what was known as new (feed, unread)', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  // One live message: this is what the daemon knew before the backfill.
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '7000', type: 1, text: 'known', sendAt: 70, raw: {} });
  const unreadBefore = kakao.listChats().find((c) => c.id === CHAT)?.unreadCount ?? 0;
  const head = (await readRecent(kakao, 0)).at(-1)?.seq ?? 0;

  const log = (id: string, text: string, sendAt: number) => ({ chatId: CHAT, authorId: '42', messageId: id, type: 1, text, sendAt, raw: {} });
  fake.replies.chatLogs = [{ status: 0, messages: [log('6000', 'old history', 60), log('8000', 'sent from the phone', 80)], eof: true, raw: {} }];
  await readHistory(kakao, CHAT, { limit: 50 });
  assert.deepEqual(new MessageStore(KakaoDb.open({ dir: kakao.config.dataDir })).getMessages(CHAT).map(m => m.messageId), ['6000', '7000', '8000']);
  assert.equal(kakao.listChats().find(c => c.id === CHAT)?.unreadCount, 1);
  assert.deepEqual((await readRecent(kakao, head)).map((m) => m.messageId), ['8000'], 'only the newer one reaches the live feed');
  const chat = kakao.listChats().find((c) => c.id === CHAT);
  assert.equal(chat?.unreadCount, 0, 'the subsequent explicit phone-read fixture resets the count');
  assert.equal(chat?.maxLogId, '8000');
});

test('the first load of a chat nothing was known about is history only', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  const head = (await readRecent(kakao, 0)).at(-1)?.seq ?? 0;
  fake.replies.chatLogs = [{ status: 0, messages: [{ chatId: CHAT, authorId: '42', messageId: '6000', type: 1, text: 'old', sendAt: 60, raw: {} }], eof: true, raw: {} }];
  await (await readHistory(kakao, CHAT, { limit: 50 }));
  assert.deepEqual((await readRecent(kakao, head)), []);
  assert.equal(kakao.listChats().find((c) => c.id === CHAT)?.unreadCount ?? 0, 0);
});

test('a SYNCDLMSG push marks the message its delete notice points at, and keeps the notice', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  // Real logIds are above 2^53; JSON.parse would round this one.
  const BIG = '3955000000000000161';
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: BIG, type: 1, text: '삭제 테스트', sendAt: 95, raw: {} });
  // Shape seen live 2026-10-20 (values made up): the chatLog is a type 0 feed notice whose logId is a bare integer.
  const notice = { chatId: CHAT, authorId: SELF, messageId: '3955000000000003495', type: 0, text: `{"logId":${BIG},"byHost":false,"hidden":true,"feedType":14}`, sendAt: 96, raw: {} };
  fake.emit('syncdlmsg', { chatLog: notice, raw: {} });

  fake.replies.chatLogs = [{ status: 0, messages: [], eof: true, raw: {} }];
  const history = await readHistory(kakao, CHAT, { limit: 50 });
  assert.deepEqual(history.messages.map((m) => m.messageId), ['3955000000000003495'], 'the deleted message is gone, the notice stays');
  assert.equal((await readRecent(kakao, 0, CHAT)).some((m) => m.messageId === BIG), false, 'and it is dropped from the live feed');
});

test('SYNCACTION push is logged without actor, type or message identifiers', () => {
  const { fake } = setup();
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '8001', type: 1, text: 'hi', sendAt: 1, raw: {} });
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stderr.write;
  try {
    fake.emit('packet', {
      header: { method: 'SYNCACTION', id: 0, status: 0 },
      data: { userId: Long.fromString(SELF), chatId: Long.fromString(CHAT), type: 1, logId: Long.fromString('8001'), status: 0 }
    });
  } finally {
    process.stderr.write = write;
  }
  const line = lines.find((l) => l.includes('account activity received'));
  assert.ok(line, lines.join(''));
  assert.equal(line.includes('logId='), false);
  assert.ok(!line.includes(SELF) && !line.includes(CHAT), 'no ids in the log line');
});

test('refreshUnread replaces local unread estimates with the server count', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'a', sendAt: 1, raw: {} });
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9002', type: 1, text: 'b', sendAt: 2, raw: {} });
  assert.equal(kakao.getUnreadSummary().find((c) => c.chatId === CHAT)?.unreadCount, 2);

  // Read on the phone: the server's chat list now says 0. A chat this daemon doesn't know is ignored.
  fake.replies.request = [{ header: { status: 0 }, data: { status: 0, chatDatas: [{ c: Long.fromString(CHAT), t: 'DirectChat', n: 0 }, { c: 555, t: 'MultiChat', n: 4 }] } }];
  assert.deepEqual(await kakao.refreshUnread(), { updated: 1, source: 'server' });
  assert.equal(fake.calls.at(-1)?.args[0], 'LCHATLIST');
  assert.equal(kakao.getUnreadSummary().length, 0);

  fake.replies.request = [{ header: { status: -500 }, data: { status: -500 } }];
  await assert.rejects(kakao.refreshUnread(), isCode('LOCO_STATUS'));
});


test('group photo upload validates images, publishes one stored type27 bundle with attachment and reports only confirmed success', async () => {
  const { kakao, fake, stored } = setup(); fake.connect();
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(20, 20);
  const extra = JSON.stringify({ kl: ['first', 'second'] }); let calls = 0;
  Object.assign(fake, { uploadMultiPhotos: async (chatId: string, opts: { items: Array<{ width: number }>; beforeStep?: () => void }) => {
    calls++; assert.equal(chatId, CHAT); assert.equal(opts.items.length, 2); assert.equal(opts.items[0].width, 10);
    opts.beforeStep?.(); return { status: 0, logId: '100', photoCount: 2, extra, raw: {} };
  } });
  await assert.rejects(kakao.uploadMultiPhotos(CHAT, [png]), isCode('INVALID_ARGUMENT'));
  assert.equal(calls, 0);
  const result = await kakao.uploadMultiPhotos(CHAT, [png, png]);
  assert.equal(result.photoCount, 2); assert.equal(stored().length, 1); assert.equal(stored()[0].type, 27);
  assert.equal(stored()[0].attachment, extra);
});

test('default-deny content paths make no requests while receipt and storage continue; metadata has no snippets', async () => {
  const { kakao, fake, stored } = setup({}, [], false);
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'private fixture', sendAt: 1, raw: {} });
  assert.equal(stored().length, 1, 'transport ingestion continues without granting exposure');
  assert.equal(kakao.listChats()[0].lastMessage, '');
  assert.equal(kakao.getUnreadSummary()[0].lastMessage, '');
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
  const before = fake.calls.length;
  const checks = [() => kakao.getHistory(CHAT), () => kakao.searchMessages('private', { chatId: CHAT }),
    () => kakao.recentMessages(0, CHAT), () => kakao.waitForMessages(0, 1, CHAT),
    () => kakao.getMeta(CHAT, [1]),
    () => kakao.downloadMedia(CHAT, { token: 'fixture', messageId: '9001' }),
    () => kakao.sendEmoticonFrom(CHAT, { chatId: CHAT, logId: '9001' })];
  for (const read of checks) await assert.rejects(read(), isCode('POLICY_DENIED'));
  assert.equal(fake.calls.length, before, 'denials precede network or history fetches');
  assert.deepEqual(stored().map(m => m.text), ['private fixture']);
});

test('manual approval permits only this bounded read, cannot bypass cross-room restrictions, and reads an unread room', async () => {
  const { kakao, fake } = setup({}, [], false);
  fake.connect(); phoneRead(kakao);
  kakao.setRoomAccess(CHAT, { mode: 'manual', maxMessages: 2 });
  await assert.rejects(kakao.getHistory(CHAT, { limit: 1 }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.getHistory(CHAT, { limit: 3, confirmRead: true }), isCode('INVALID_ARGUMENT'));
  assert.deepEqual(await kakao.searchMessages('fixture', { chatId: CHAT, limit: 2, confirmRead: true }), []);
  await assert.rejects(kakao.searchMessages('fixture', { chatId: CHAT, limit: 2 }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.searchMessages('fixture', { confirmRead: true }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.recentMessages(0), isCode('POLICY_DENIED'));
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'fixture', sendAt: 1, raw: {} });
  const count = fake.calls.length;
  assert.deepEqual((await kakao.searchMessages('fixture', { chatId: CHAT, limit: 1, confirmRead: true })).map(m => m.messageId), ['9001']);
  assert.equal(fake.calls.length, count, 'an approved read of an unread room needs no network call and sends no read receipt');
});

test('wait returns an arriving message to an approved room and rechecks revocation before returning', async () => {
  const { kakao, fake } = setup();
  fake.connect(); phoneRead(kakao);
  const waiting = kakao.waitForMessages(0, 100, CHAT);
  await new Promise(resolve => setImmediate(resolve));
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'do not expose', sendAt: 1, raw: {} });
  assert.deepEqual((await waiting).map(m => m.messageId), ['9001']);
  const waiting2 = kakao.waitForMessages(kakao.cursor, 5, CHAT);
  await new Promise(resolve => setImmediate(resolve));
  kakao.setRoomAccess(CHAT, { mode: 'deny' });
  await assert.rejects(waiting2, isCode('POLICY_DENIED'));
});

test('an approved room with unknown server counts is readable without a read-state request, and a narrowed rule refuses it', async () => {
  const { kakao, fake } = setup();
  fake.connect();
  const count = fake.calls.length;
  assert.deepEqual(await kakao.searchMessages('fixture', { chatId: CHAT }), []);
  assert.equal(fake.calls.length, count);
  kakao.setRoomAccess(CHAT, { mode: 'deny' });
  await assert.rejects(kakao.searchMessages('fixture', { chatId: CHAT }), isCode('POLICY_DENIED'));
});

test('read receipts need separate confirmation and media tokens must belong to a visible source message', async () => {
  const { kakao, fake } = setup(); fake.connect(); phoneRead(kakao);
  await assert.rejects(kakao.markRead(CHAT, '9001'), isCode('POLICY_DENIED'));
  assert.equal(fake.calls.length, 0);
  fake.replies.markRead = [{ status: 0 }];
  await kakao.markRead(CHAT, '9001', true);
  fake.replies.sendText = [{ status: 0, logId: '9001', raw: { chatLog: { attachment: { k: 'own-token' } } } }];
  await kakao.sendMessage(CHAT, 'fixture');
  await assert.rejects(kakao.downloadMedia(CHAT, { token: 'other-room-token', messageId: '9001' }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.downloadMedia(CHAT, { token: 'own-token' }), isCode('POLICY_DENIED'));
  kakao.hideMessages(CHAT, ['9001']);
  await assert.rejects(kakao.downloadMedia(CHAT, { token: 'own-token', messageId: '9001' }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.getTrailer('own-token'), isCode('POLICY_DENIED'));
  assert.equal(fake.calls.filter(c => c.method === 'downloadMedia').length, 0);
});

test('userMarkRead marks read without confirmation and falls back to newest stored logId', async () => {
  const { kakao, fake } = setup(); fake.connect();
  fake.replies.markRead = [{ status: 0 }];
  const res = await kakao.userMarkRead(CHAT, '9002');
  assert.equal(res.status, 0);
  assert.equal(res.watermark, '9002');
  assert.ok(fake.calls.some(c => c.method === 'markRead' && c.args[0] === CHAT && c.args[1] === '9002'));
});

test('expiring unread preview exposes only new local bodies and sends count queries, never read receipts or history fetch', async () => {
  const { kakao, fake } = setup({}, [], false);
  fake.connect();
  for (const messageId of ['100', '101', '102']) fake.emit('message', { chatId: CHAT, messageId, authorId: '42',
    text: `fixture ${messageId}`, type: 1, sendAt: Number(messageId), raw: {} });
  const rule = { mode: 'manual', unreadPreviewAfterLogId: '100', expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), maxMessages: 20 };
  kakao.setRoomAccess(CHAT, rule);
  await assert.rejects(kakao.previewUnreadMessages(CHAT), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.getHistory(CHAT, { limit: 1, confirmRead: true }), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.previewUnreadMessages('333', { confirmRead: true }), isCode('POLICY_DENIED'));
  fake.replies.request = [1, 2].map(() => ({ header: { status: 0 }, data: { chatDatas: [{ c: CHAT, n: 3 }] } }));
  const callsBefore = fake.calls.length;
  const preview = await kakao.previewUnreadMessages(CHAT, { confirmRead: true });
  assert.deepEqual(preview.messages.map(m => m.text), ['fixture 101', 'fixture 102']);
  assert.equal(preview.unreadBefore, 3); assert.equal(preview.unreadAfter, 3);
  assert.equal(preview.readReceiptSent, false); assert.equal(preview.historyFetchSent, false);
  assert.deepEqual(fake.calls.slice(callsBefore).map(c => [c.method, c.args[0]]), [['request', 'LCHATLIST'], ['request', 'LCHATLIST']]);
  kakao.setRoomAccess(CHAT, { mode: 'deny' });
  await assert.rejects(kakao.previewUnreadMessages(CHAT, { confirmRead: true }), isCode('POLICY_DENIED'));
});

test('unread preview rejects missing server metadata and approval revoked during a count request', async () => {
  const { kakao, fake } = setup(); fake.connect();
  kakao.setRoomAccess(CHAT, { mode: 'manual', unreadPreviewAfterLogId: '0', maxMessages: 20,
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString() });
  fake.replies.request = [{ header: { status: 0 }, data: { chatDatas: [] } }];
  await assert.rejects(kakao.previewUnreadMessages(CHAT, { confirmRead: true }), isCode('ROOM_NOT_READ'));
  fake.request = async () => {
    kakao.setRoomAccess(CHAT, { mode: 'deny' });
    return { header: { status: 0 }, data: { chatDatas: [{ c: CHAT, n: 2 }] } };
  };
  await assert.rejects(kakao.previewUnreadMessages(CHAT, { confirmRead: true }), isCode('POLICY_DENIED'));
});


test('human history is independent of agent deny and unread gates, without changing grants or requesting read receipts', async () => {
  const { kakao, fake } = setup({}, [], false);
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'private fixture', sendAt: 1, raw: {} });
  fake.replies.chatLogs = [{ status: 0, messages: [], eof: true, raw: {} }];
  const result = await kakao.getUserHistory(CHAT, { limit: 30 });
  assert.deepEqual(result.messages.map(m => m.text), ['private fixture']);
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
  assert.equal(fake.calls.some(c => c.method === 'markRead'), false);
  assert.equal(fake.calls.some(c => c.method === 'request' && c.args[0] === 'NOTIREAD'), false);
  await assert.rejects(kakao.getHistory(CHAT, { confirmRead: true, human: true } as any), isCode('POLICY_DENIED'));
  await assert.rejects(kakao.getUserHistory('123123123', { limit: 30 }), isCode('NOT_FOUND'));
  await assert.rejects(kakao.getUserHistory(CHAT, { limit: 51 }), isCode('INVALID_ARGUMENT'));
});

test('human original media resolves tokens from visible stored messages while agent media remains denied', async t => {
  const { kakao, fake, dir } = setup({}, [], false);
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.connect(); fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 18, text: 'fixture', sendAt: 1,
    attachment: JSON.stringify({ k: 'fixture-stored-token', s: 3 }), raw: {} });
  fake.replies.downloadMedia = [{ status: 0, data: Buffer.from('abc'), size: 3 }];
  assert.equal((await kakao.getUserMedia(CHAT, '9001')).data.toString(), 'abc');
  const download = fake.calls.find(c => c.method === 'downloadMedia')!;
  assert.equal((download.args[1] as any).token, 'fixture-stored-token');
  assert.equal((download.args[1] as any).maxBytes, 16 * 1024 * 1024);
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
  await assert.rejects(kakao.downloadMedia(CHAT, { token: 'fixture-stored-token', messageId: '9001' }), isCode('POLICY_DENIED'));
  kakao.hideMessages(CHAT, ['9001']);
  await assert.rejects(kakao.getUserMedia(CHAT, '9001'), isCode('NOT_FOUND'));
});


test('human live refresh is local, bounded, room scoped and propagates deletions without agent grants', async () => {
  const { kakao, fake } = setup({}, [], false); fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'fixture live', sendAt: 1, raw: {} });
  const calls = fake.calls.length;
  assert.deepEqual(kakao.getUserUpdates(CHAT, '0', []).messages.map(m => m.messageId), ['9001']);
  kakao.hideMessages(CHAT, ['9001']);
  assert.deepEqual(kakao.getUserUpdates(CHAT, '9001', ['9001']).removedIds, ['9001']);
  assert.equal(fake.calls.length, calls);
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
  assert.throws(() => kakao.getUserUpdates('123123123', '0', []), isCode('NOT_FOUND'));
  assert.throws(() => kakao.getUserUpdates(CHAT, 'no', []), isCode('INVALID_ARGUMENT'));
});


test('human history pages, local search and explicit forward server traversal stay scoped and do not mark read', async () => {
  const { kakao, fake } = setup({}, [], false); fake.connect();
  for (let i = 0; i < 65; i++) fake.emit('message', { chatId: CHAT, authorId: '42', messageId: String(9000 + i), type: 1, text: `fixture page ${i}`, sendAt: i + 1, raw: {} });
  const recent = kakao.getUserStoredHistory(CHAT);
  assert.equal(recent.hasMore, true); assert.equal(recent.messages.length, 30); assert.equal(recent.messages[0].messageId, '9035');
  const older = kakao.getUserStoredHistory(CHAT, '9035');
  assert.equal(older.messages[0].messageId, '9005'); assert.equal(older.messages.at(-1)?.messageId, '9034');
  assert.equal(kakao.getUserStoredHistory(CHAT, undefined, 'fixture page 12').messages.length, 1);
  const before = fake.calls.length;
  assert.throws(() => kakao.getUserStoredHistory('123123123'), isCode('NOT_FOUND'));
  assert.throws(() => kakao.getUserStoredHistory(CHAT, '9223372036854775808'), isCode('INVALID_ARGUMENT'));
  assert.throws(() => kakao.getUserStoredHistory(CHAT, undefined, 'x'.repeat(201)), isCode('INVALID_ARGUMENT'));
  assert.equal(fake.calls.length, before);
  fake.replies.chatLogs = [{ status: 0, messages: [{ chatId: CHAT, authorId: '42', messageId: '8001', type: 1, text: 'fixture server page', sendAt: 0, raw: {} }], eof: false, raw: {} }];
  const first = await kakao.getUserServerHistory(CHAT, '0', '9064');
  assert.equal(first.cursor, '8001'); assert.equal(first.max, '9064'); assert.equal(first.hasMore, true);
  assert.deepEqual(first.messages.map(m => m.messageId), ['8001']);
  fake.replies.chatLogs = [{ status: 0, messages: [], eof: true, raw: {} }];
  assert.equal((await kakao.getUserServerHistory(CHAT, first.cursor, first.max)).hasMore, false);
  assert.equal(fake.calls.some(c => c.method === 'markRead'), false);
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
});

test('human server history reports provider failures and live refresh cannot reveal another room or hidden bodies', async () => {
  const { kakao, fake } = setup({}, [], false); fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 1, text: 'fixture', sendAt: 1, raw: {} });
  fake.emit('message', { chatId: '123123123', authorId: '42', messageId: '9002', type: 1, text: 'fixture other room', sendAt: 2, raw: {} });
  assert.equal(kakao.getUserUpdates(CHAT, '9001', ['9002']).messages.length, 0);
  assert.deepEqual(kakao.getUserUpdates(CHAT, '9001', ['9002']).removedIds, ['9002']);
  fake.replies.chatLogs = [{ status: -300, messages: [], eof: true, raw: {} }];
  await assert.rejects(kakao.getUserServerHistory(CHAT, '0', '9001'), isCode('LOCO_STATUS'));
  fake.replies.chatLogs = [];
  await assert.rejects(kakao.getUserHistory(CHAT), isCode('NETWORK'));
});

test('human media enables reuse publication without weakening agent defaults or creating a second session', async () => {
  const { kakao, fake } = setup({}, [], false); fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9001', type: 1, text: 'fixture', sendAt: 1, raw: {} });
  fake.replies.uploadMedia = [{ status: 0, chatLog: { logId: '9002', chatId: CHAT, type: 18, message: 'fixture.txt', sendAt: 2 }, raw: {} }, { status: 0, chatLog: { logId: '9003', chatId: CHAT, type: 18, message: 'fixture.txt', sendAt: 3 }, raw: {} }];
  const options = { type: 18, data: Buffer.from('fixture'), fileName: 'fixture.txt' };
  await kakao.uploadUserMedia(CHAT, options);
  await kakao.uploadMedia(CHAT, options);
  const uploads = fake.calls.filter(c => c.method === 'uploadMedia');
  assert.equal((uploads[0].args[1] as any).commitReuse, true); assert.equal((uploads[1].args[1] as any).commitReuse, undefined);
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'deny');
  await assert.rejects(kakao.uploadUserMedia('123123123', options), isCode('NOT_FOUND'));
});

test('per-message unread status reflects DECUNREAD watermarks and incoming replies', async () => {
  const { kakao, fake } = setup({}, [], false); fake.connect();
  // 1:1 chat between SELF and other user '42'.
  // First, an incoming message from '42' at logId 100.
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '100', type: 1, text: 'hello', sendAt: 10, raw: {} });
  // Self sends message 101.
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '101', type: 1, text: 'hi', sendAt: 11, raw: {} });

  // Outbound message 101 has not been read yet by '42' -> unread: 1.
  const history1 = kakao.getUserStoredHistory(CHAT);
  const msg100 = history1.messages.find(m => m.messageId === '100');
  const msg101 = history1.messages.find(m => m.messageId === '101');
  assert.equal(msg100?.unread, 0, 'incoming message has unread: 0');
  assert.equal(msg101?.unread, 1, 'unopened outbound message has unread: 1');

  // '42' opens the chat and server sends DECUNREAD up to watermark 101.
  fake.emit('read', { chatId: CHAT, userId: '42', watermark: '101' });

  // Now message 101 is read -> unread: 0.
  const history2 = kakao.getUserStoredHistory(CHAT);
  const msg101AfterRead = history2.messages.find(m => m.messageId === '101');
  assert.equal(msg101AfterRead?.unread, 0, 'read message has unread: 0');

  // Self sends message 102.
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '102', type: 1, text: 'are you there?', sendAt: 12, raw: {} });
  const updates = kakao.getUserUpdates(CHAT, '100', ['101', '102']);
  const msg102 = updates.messages.find(m => m.messageId === '102');
  assert.equal(msg102?.unread, 1, 'new outbound message is unread');

  // '42' replies with message 103 without a separate DECUNREAD.
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '103', type: 1, text: 'yes I am', sendAt: 13, raw: {} });
  const updatesAfterReply = kakao.getUserUpdates(CHAT, '100', ['101', '102', '103']);
  const msg102AfterReply = updatesAfterReply.messages.find(m => m.messageId === '102');
  assert.equal(msg102AfterReply?.unread, 0, 'outbound message before reply is automatically marked read');
});

test('durable inbox reads an unread approved room, preserves deny gates, rechecks permission at ack and makes no history/read-receipt call', async t => {
  const { kakao, fake, dir } = setup(); t.after(async () => { await kakao.stop(); removeTestDir(dir); });
  fake.connect(); fake.emit('message', { chatId: CHAT, messageId: '9007199254740993', authorId: '42', type: 1, text: 'fixture inbox', sendAt: 1, raw: {} });
  const batch = await kakao.claimMessageEvents(CHAT, 'worker', { limit: 10 });
  assert.equal(batch.events.length, 1); assert.equal(batch.events[0].messageId, '9007199254740993');
  const request = { chatId: CHAT, consumer: 'worker', sourceGeneration: batch.sourceGeneration, events: batch.events.map(({ eventId,leaseId }) => ({eventId,leaseId})) };
  kakao.setRoomAccess(CHAT, { mode: 'deny' });
  await assert.rejects(kakao.ackMessageEvents(request), { code: 'POLICY_DENIED' });
  kakao.setRoomAccess(CHAT, { mode: 'immediate', maxMessages: 100, callsPerHour: 3600 });
  assert.equal((await kakao.ackMessageEvents(request)).acknowledged, 1);
  assert.equal((await kakao.ackMessageEvents(request)).alreadyAcknowledged, 1);
  assert.ok(fake.calls.every(c => c.method === 'request' && c.args[0] === 'LCHATLIST'));
});

test('push failure rolls message/work/cursor back before waking feed; restart recovers events without another push', async t => {
  const logs: string[] = [];
  const { kakao, fake, dir } = setup({}, [], true, line => logs.push(line));
  const db = KakaoDb.open({ dir: kakao.config.dataDir });
  let restarted: KakaoSession | undefined;
  t.after(async () => { await restarted?.stop(); await kakao.stop(); db.close(); removeTestDir(dir); });
  fake.connect();
  const row = { chatId: CHAT, messageId: '9007199254740993', authorId: '42', type: 1, text: 'fixture transactional push', sendAt: 1, raw: {} };
  db.db.exec(`CREATE TRIGGER fixture_inbox_failure BEFORE INSERT ON message_inbox_events BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
  // The storage error is logged by code and contained; it never escapes into the LOCO reader.
  assert.doesNotThrow(() => fake.emit('message', row));
  assert.ok(logs.includes('message event handling failed: INTERNAL'), logs.join('\n'));
  assert.equal(kakao.cursor, 0); assert.equal(new MessageStore(db).getMessage(CHAT, row.messageId), undefined);
  assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM message_ingestion_cursors').get() as { n: number }).n, 0);
  db.db.exec('DROP TRIGGER fixture_inbox_failure'); fake.emit('message', row);
  assert.equal(kakao.cursor, 1);
  const other = new FakeLocoSession(); restarted = new KakaoSession(kakao.config, { session: other as unknown as ResilientLocoSession });
  other.emit('connected', { endpoint: { host: 'loco.test', port: 443 }, loginList: { conversations: [{ id: CHAT, type: 'DirectChat', unreadCount: 0, raw: {} }], raw: {} } });
  const recovered = await restarted.claimMessageEvents(CHAT, 'recovered');
  assert.equal(recovered.events.length, 1); assert.equal(recovered.events[0].message.text, row.text);
  assert.equal(restarted.cursor, 0, 'legacy transient feed still resets independently');
});

test('known-new history sync stores its message and durable event atomically before feed notification', async t => {
  const { kakao, fake, dir } = setup(); const db = KakaoDb.open({ dir: kakao.config.dataDir });
  t.after(async () => { await kakao.stop(); db.close(); removeTestDir(dir); });
  fake.connect(); fake.emit('message', { chatId: CHAT, messageId: '1', authorId: SELF, type: 1, text: 'fixture baseline', sendAt: 1, raw: {} });
  phoneRead(kakao);
  db.db.exec(`CREATE TRIGGER fixture_sync_failure BEFORE INSERT ON message_inbox_events WHEN NEW.message_id='2' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
  fake.replies.chatLogs = [{ status: 0, messages: [{ chatId: CHAT, messageId: '2', authorId: SELF, type: 1, text: 'fixture newer sync', sendAt: 2, raw: {} }], eof: true, raw: {} }];
  await assert.rejects(kakao.getHistory(CHAT), { code: 'INTERNAL' });
  assert.equal(kakao.cursor, 1); assert.equal(new MessageStore(db).getMessage(CHAT, '2'), undefined);
  db.db.exec('DROP TRIGGER fixture_sync_failure');
  fake.replies.chatLogs = [{ status: 0, messages: [{ chatId: CHAT, messageId: '2', authorId: SELF, type: 1, text: 'fixture newer sync', sendAt: 2, raw: {} }], eof: true, raw: {} }];
  await kakao.getHistory(CHAT);
  const events = await kakao.claimMessageEvents(CHAT, 'worker');
  assert.deepEqual(events.events.map(e => e.messageId), ['1','2']);
});

test('mutation inspection enforces source visibility, reads an unread approved room, detaches approved bytes and detects later source changes',async t=>{
  const {kakao,fake,dir}=setup();const db=KakaoDb.open({dir:kakao.config.dataDir});
  t.after(()=>{kakao.stop();db.close();removeTestDir(dir);});
  const message={chatId:CHAT,messageId:'9007199254740993',authorId:SELF,type:20,text:'fixture original',attachment:' {"name":"fixture","path":"fixture/path","alt":"fixture"} ',sendAt:1,raw:{}};
  fake.connect();fake.emit('message',message);
  fake.emit('connected',{endpoint:{host:'loco.test',port:443},loginList:{conversations:[{id:CHAT,type:'DirectChat',unreadCount:1,raw:{}}],raw:{}}});
  const source=await kakao.inspectAgentStoredMessage(CHAT,message.messageId);
  assert.equal(source.emoticonSupported,true);source.target.text='mutated by caller';
  const packets:any[]=[];(fake as any).sendEmoticonRaw=async(...args:any[])=>{packets.push(args);return {status:0,logId:'9007199254740994',raw:{}};};
  await source.sendEmoticonTo(CHAT);
  assert.equal(packets[0][1].text,message.text);assert.equal(packets[0][1].extra,message.attachment);
  phoneRead(kakao);const inspected=await kakao.inspectAgentStoredMessage(CHAT,message.messageId);
  const store=new MessageStore(db);store.saveMessage({...store.getMessage(CHAT,message.messageId)!,text:'fixture changed'});
  assert.throws(()=>inspected.validate(),{code:'OPERATION_STALE'});
  store.hideMessages(CHAT,[message.messageId]);await assert.rejects(kakao.inspectAgentStoredMessage(CHAT,message.messageId),{code:'NOT_FOUND'});
  kakao.setRoomAccess(CHAT,{mode:'deny'});assert.throws(()=>source.validate(),{code:'POLICY_DENIED'});
  assert.equal(packets.length,1);
});

test('open-room read receipt ACK preserves server unread and reports verification separately', async () => {
  const { kakao, fake } = setup();
  fake.emit('connected', { endpoint: { host: 'fixture', port: 443 }, loginList: {
    conversations: [{ id: CHAT, type: 'OM', unreadCount: 31, raw: { l: { logId: '9001' } } }], raw: {} } });
  fake.replies.markRead = [{ status: 0 }];
  fake.replies.request = [{ header: { status: 0 }, data: { chatDatas: [{ c: CHAT, n: 31 }] } }];
  const result = await kakao.markRead(CHAT, '9001', true);
  assert.equal(result.status, 0);
  assert.deepEqual(result.readState, { confirmed: false, reason: 'server_unread', localUnreadCount: 31, serverUnreadCount: 31 });
  assert.equal(kakao.listChats()[0].unreadCount, 31);
  assert.equal(fake.calls.filter(c => c.method === 'markRead').length, 1);
  assert.equal(fake.calls.filter(c => c.method === 'chatLogs').length, 0);
});

test('fresh metadata distinguishes missing/unknown rooms and does not erase a concurrent push', async () => {
  const { kakao, fake } = setup(); phoneRead(kakao);
  fake.replies.request = [ { header: { status: 0 }, data: { chatDatas: [] } },
    { header: { status: 0 }, data: {} },
    { header: { status: 0 }, data: { chatDatas: [{ c: CHAT }] } } ];
  assert.equal((await kakao.inspectRoomReadState(CHAT)).reason, 'room_missing');
  assert.equal((await kakao.inspectRoomReadState(CHAT)).reason, 'unread_unknown');
  fake.request = async () => {
    fake.emit('message', { chatId: CHAT, messageId: '100', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
    return { header: { status: 0 }, data: { chatDatas: [{ c: CHAT, n: 0 }] } };
  };
  const state = await kakao.inspectRoomReadState(CHAT);
  assert.equal(state.confirmed, false);
  assert.equal(state.reason, 'local_state_changed');
  assert.equal(kakao.listChats()[0].unreadCount, 1);
});

test('acknowledged read receipt verification failure does not request another receipt', async () => {
  const { kakao, fake } = setup(); phoneRead(kakao);
  fake.replies.markRead = [{ status: 0 }];
  fake.replies.request = [{ header: { status: -500 }, data: { status: -500 } }];
  const result = await kakao.markRead(CHAT, '100', true);
  assert.deepEqual(result.readState, { confirmed: false, reason: 'refresh_failed' });
  assert.equal(fake.calls.filter(c => c.method === 'markRead').length, 1);
});

const RANGE_FROM = '2026-10-23T00:00:00-07:00';
const RANGE_TO = '2026-10-25T00:00:00-07:00';
const RANGE_START = Date.parse(RANGE_FROM) / 1000;

test('range history uses timezone bounds and stable local pages, excluding hidden/deleted/other-room records', async () => {
  const { kakao, fake } = setup();
  const db = KakaoDb.open({ dir: kakao.config.dataDir }), store = new MessageStore(db);
  const row = (messageId: string, sendAt: number, chatId = CHAT, type = 1) =>
    ({ seq: 0, chatId, messageId, authorId: SELF, type, text: 'fixture', sendAt });
  for (const r of [row('100', RANGE_START - 1), row('101', RANGE_START), row('102', RANGE_START + 1),
    row('103', RANGE_START + 1), row('104', RANGE_START + 2), row('105', RANGE_START + 3, CHAT, 16385),
    row('106', RANGE_START + 4, '555555555'), row('107', Date.parse(RANGE_TO) / 1000)]) store.saveMessage(r);
  store.hideMessages(CHAT, ['104']);
  phoneRead(kakao);
  fake.replies.chatLogs = [{ status: 0, messages: [], eof: true, raw: {} }];
  const first = await kakao.getHistoryRange(CHAT, { from: RANGE_FROM, to: RANGE_TO, limit: 2 });
  assert.equal(first.pending, false);
  assert.deepEqual(first.messages.map(m => m.messageId), ['102', '103']);
  assert.equal(first.coverage.completeRequestedPeriod, false);
  assert.ok(first.nextCursor);
  const second = await kakao.getHistoryRange(CHAT, { from: RANGE_FROM, to: RANGE_TO, limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.messages.map(m => m.messageId), ['101']);
  assert.equal(second.nextCursor, null);
  assert.equal(fake.calls.filter(c => c.method === 'chatLogs').length, 1);
  assert.equal(fake.calls.filter(c => c.method === 'markRead').length, 0);
});

test('range history scans forward before presenting a summary and binds cursors to room/date', async () => {
  const { kakao, fake } = setup();
  const store = new MessageStore(KakaoDb.open({ dir: kakao.config.dataDir }));
  const message = (n: number) => ({ chatId: CHAT, messageId: String(n), authorId: SELF, type: 1,
    text: 'fixture', sendAt: RANGE_START + n, raw: {} });
  store.saveMessage({ ...message(300), seq: 0 }); phoneRead(kakao);
  fake.replies.chatLogs = [
    { status: 0, messages: [message(100), message(200)], eof: false, raw: {} },
    { status: 0, messages: [message(300)], eof: true, raw: {} }
  ];
  const first = await kakao.getHistoryRange(CHAT, { from: RANGE_FROM, to: RANGE_TO, limit: 2 });
  assert.equal(first.pending, true); assert.deepEqual(first.messages, []); assert.ok(first.nextCursor);
  const count = fake.calls.length;
  await assert.rejects(kakao.getHistoryRange('555555555', { from: RANGE_FROM, to: RANGE_TO, cursor: first.nextCursor! }), isCode('INVALID_ARGUMENT'));
  await assert.rejects(kakao.getHistoryRange(CHAT, { from: '2026-10-24T00:00:00-07:00', to: RANGE_TO, cursor: first.nextCursor! }), isCode('INVALID_ARGUMENT'));
  assert.equal(fake.calls.length, count);
  const second = await kakao.getHistoryRange(CHAT, { from: RANGE_FROM, to: RANGE_TO, limit: 2, cursor: first.nextCursor! });
  assert.equal(second.pending, false); assert.deepEqual(second.messages.map(m => m.messageId), ['200', '300']);
  assert.equal(fake.calls.filter(c => c.method === 'chatLogs')[1].args[1] instanceof Array, true);
  assert.deepEqual(fake.calls.filter(c => c.method === 'chatLogs')[1].args[1], ['200']);
});

test('range read rejects naive dates and revocation during provider fetch exposes/persists nothing', async () => {
  const { kakao, fake, stored } = setup(); phoneRead(kakao);
  await assert.rejects(kakao.getHistoryRange(CHAT, { from: '2026-10-23', to: RANGE_TO }), isCode('INVALID_ARGUMENT'));
  assert.equal(fake.calls.length, 0);
  const store = new MessageStore(KakaoDb.open({ dir: kakao.config.dataDir }));
  store.saveMessage({ seq: 0, chatId: CHAT, messageId: '300', authorId: SELF, text: 'fixture', type: 1, sendAt: RANGE_START });
  phoneRead(kakao);
  fake.chatLogs = async () => {
    kakao.setRoomAccess(CHAT, { mode: 'deny' });
    return { status: 0, messages: [{ chatId: CHAT, messageId: '100', authorId: SELF, text: 'must not persist', sendAt: RANGE_START }], eof: true, raw: {} };
  };
  await assert.rejects(kakao.getHistoryRange(CHAT, { from: RANGE_FROM, to: RANGE_TO }), isCode('POLICY_DENIED'));
  assert.deepEqual(stored().map(m => m.messageId), ['300']);
});

test('both modes read an approved room with unread messages, trust also without a room rule, and never mark it read', async () => {
  const unreadRoom = async (mode: 'ask' | 'trust', grantAccess: boolean) => {
    const { kakao, fake } = setup({ KAKAO_AGENT_MODE: mode }, [], grantAccess);
    fake.connect();
    fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '7100', type: 1, text: 'new and unread', sendAt: 71, raw: {} });
    assert.equal(kakao.listChats().find(c => c.id === CHAT)?.unreadCount, 1);
    return { kakao, fake };
  };

  const ask = await unreadRoom('ask', true);
  assert.deepEqual((await ask.kakao.recentMessages(0, CHAT)).map(m => m.messageId), ['7100']);
  assert.equal(ask.kakao.listChats().find(c => c.id === CHAT)?.unreadCount, 1, 'reading leaves the room unread');
  assert.equal(ask.fake.calls.filter(c => c.method === 'markRead').length, 0);
  const askDenied = await unreadRoom('ask', false);
  await assert.rejects(askDenied.kakao.recentMessages(0, CHAT), isCode('POLICY_DENIED'));

  const trust = await unreadRoom('trust', false);
  assert.deepEqual((await trust.kakao.recentMessages(0, CHAT)).map(m => m.messageId), ['7100']);
  assert.equal(trust.kakao.listChats().find(c => c.id === CHAT)?.unreadCount, 1, 'reading leaves the room unread');
  assert.equal(trust.fake.calls.filter(c => c.method === 'markRead').length, 0);

  trust.kakao.tightenRoomAccess(CHAT, { mode: 'deny' }); // a room the person denied stays closed in trust
  await assert.rejects(trust.kakao.recentMessages(0, CHAT), isCode('POLICY_DENIED'));
});

test('leaving a room by any path withdraws its read rule and read grants and tells listeners', async t => {
  const { kakao, fake, dir } = setup();
  t.after(async () => { await kakao.stop(); removeTestDir(dir); });
  const left: string[] = [];
  kakao.onChatLeft((chatId, reason) => left.push(`${reason}:${chatId}`));
  const OTHER = '555555555', GONE = '666666666';
  for (const id of [OTHER, GONE]) kakao.setRoomAccess(id, { mode: 'immediate' });
  fake.connect();
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stderr.write;
  try {
    fake.replies.leave = [{ status: 0 }];
    await kakao.leave(CHAT);
    // Shape seen live when the account left a room on the phone.
    fake.emit('packet', { header: { method: 'LEFT', id: 0, status: 0 }, data: { chatId: Long.fromString(OTHER), lastTokenId: Long.fromString('1'), serviceId: 0, status: 0 } });
    fake.emit('connected', { endpoint: { host: 'loco.test', port: 443 }, loginList: { conversations: [], raw: { delChatIds: [Long.fromString(GONE)] } } });
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(left, [`leave_chat:${CHAT}`, `other_device:${OTHER}`, `login_list:${GONE}`]);
  for (const id of [CHAT, OTHER, GONE]) assert.deepEqual(kakao.getRoomAccess(id).rule, { mode: 'deny' }, 'a rejoin asks again');
  assert.ok(!lines.join('').includes(OTHER) && !lines.join('').includes(GONE), 'no ids in the log');
});

test('a failed leave keeps the room permissions', async t => {
  const { kakao, fake, dir } = setup();
  t.after(async () => { await kakao.stop(); removeTestDir(dir); });
  let calls = 0; kakao.onChatLeft(() => { calls++; });
  fake.connect(); fake.replies.leave = [{ status: -500 }];
  await assert.rejects(kakao.leave(CHAT));
  assert.equal(kakao.getRoomAccess(CHAT).rule.mode, 'immediate'); assert.equal(calls, 0);
});


test('fresh exact metadata confirms a read room absent from the list without sending a read receipt', async () => {
  const { kakao, fake } = setup();
  fake.emit('connected', { endpoint: { host: 'fixture', port: 443 }, loginList: {
    conversations: [{ id: CHAT, type: 'OD', unreadCount: 1, raw: {} }], raw: {} } });
  fake.replies.request = [
    { header: { status: 0 }, data: { chatDatas: [] } },
    { header: { status: 0 }, data: { chatInfo: { chatId: Long.fromString(CHAT), newMessageCount: 0, invalidNewMessageCount: false } } }
  ];
  assert.deepEqual(await kakao.inspectRoomReadState(CHAT), {
    confirmed: true, reason: 'confirmed_read', localUnreadCount: 1, serverUnreadCount: 0, source: 'chat_info',
    verification: { countValid: true, countProvided: true, countValidityKnown: true, countMarkedInvalid: false,
      watermarkKnown: false, watermarkCoversHead: false, serverHeadCoversLocal: false, accountSeenCoversServer: false }
  });
  assert.equal(kakao.listChats()[0].unreadCount, 0);
  assert.deepEqual(fake.calls.filter(c => c.method === 'request').map(c => c.args[0]), ['LCHATLIST', 'CHATINFO']);
  const detail = fake.calls.filter(c => c.method === 'request').at(-1)!;
  assert.equal(String((detail.args[1] as any).chatId), CHAT);
  assert.equal(fake.calls.some(c => ['markRead', 'chatLogs', 'sendText'].includes(c.method)), false);
});

test('missing-room fallback rejects invalid counts, unbound metadata and departed rooms', async () => {
  for (const extra of [
    { newMessageCount: 2, invalidNewMessageCount: false },
    { newMessageCount: 0, invalidNewMessageCount: true },
    { newMessageCount: 0, invalidNewMessageCount: 'false' },
    { newMessageCount: -1, invalidNewMessageCount: false },
    { newMessageCount: 0.5, invalidNewMessageCount: false },
    { newMessageCount: '0', invalidNewMessageCount: false },
    { newMessageCount: 0, invalidNewMessageCount: false, chatId: '123' },
    { newMessageCount: 0, invalidNewMessageCount: false, left: true }
  ]) {
    const { kakao, fake } = setup(); phoneRead(kakao);
    fake.replies.request = [
      { header: { status: 0 }, data: { chatDatas: [] } },
      { header: { status: 0 }, data: { chatInfo: { chatId: CHAT, ...extra } } }
    ];
    assert.equal((await kakao.inspectRoomReadState(CHAT)).confirmed, false);
  }
});

test('missing-room metadata refresh cannot erase a concurrent push or hide a server rejection', async () => {
  const { kakao, fake } = setup(); phoneRead(kakao);
  fake.request = async (method: string) => {
    if (method === 'LCHATLIST') return { header: { status: 0 }, data: { chatDatas: [] } };
    fake.emit('message', { chatId: CHAT, messageId: '100', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
    return { header: { status: 0 }, data: { chatInfo: { chatId: CHAT, newMessageCount: 0, invalidNewMessageCount: false } } };
  };
  assert.equal((await kakao.inspectRoomReadState(CHAT)).reason, 'local_state_changed');
  assert.equal(kakao.listChats()[0].unreadCount, 1);
  fake.request = async (method: string) => method === 'LCHATLIST' ? { header: { status: 0 }, data: { chatDatas: [] } } :
    { header: { status: -500 }, data: { status: -500 } };
  await assert.rejects(kakao.inspectRoomReadState(CHAT), isCode('LOCO_STATUS'));
});


test('exact account read watermark can verify a missing room whose count is unknown', async () => {
  for (const seen of ['9007199254740993', Long.fromString('9007199254740994')]) {
    const { kakao, fake } = setup(); phoneRead(kakao);
    fake.replies.request = [
      { header: { status: 0 }, data: { chatDatas: [] } },
      { header: { status: 0 }, data: { chatInfo: { chatId: CHAT, invalidNewMessageCount: true,
        lastLogId: Long.fromString('9007199254740993'), lastSeenLogId: seen } } }
    ];
    const result = await kakao.inspectRoomReadState(CHAT);
    assert.equal(result.confirmed, true);
    assert.equal(result.source, 'chat_info_watermark');
    assert.equal(result.serverUnreadCount, 0);
    assert.equal(kakao.listChats()[0].unreadCount, 0);
  }
});

test('unknown, unsafe, stale or other-room watermarks never confirm a read room', async () => {
  for (const extra of [
    { lastSeenLogId: '9007199254740992' },
    { lastSeenLogId: undefined },
    { lastSeenLogId: 9007199254740992 },
    { lastLogId: '0', lastSeenLogId: '9007199254740993' },
    { lastSeenLogId: '9007199254740993', chatId: '123' },
    { lastSeenLogId: '9007199254740993', newMessageCount: 1, invalidNewMessageCount: false }
  ]) {
    const { kakao, fake } = setup(); phoneRead(kakao);
    fake.emit('message', { chatId: CHAT, messageId: '100', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
    fake.replies.request = [
      { header: { status: 0 }, data: { chatDatas: [] } },
      { header: { status: 0 }, data: { chatInfo: { chatId: CHAT, invalidNewMessageCount: true,
        lastLogId: '9007199254740993', ...extra } } }
    ];
    assert.equal((await kakao.inspectRoomReadState(CHAT)).confirmed, false);
    assert.notEqual(kakao.listChats()[0].unreadCount, 0);
  }
});

test('unknown cached read state is distinguished from a positive unread estimate', async () => {
  const { kakao, fake } = setup();
  fake.emit('connected', { endpoint: { host: 'fixture', port: 443 }, loginList: {
    conversations: [{ id: CHAT, type: 'OD', raw: {} }], raw: {} } });
  assert.equal(kakao.listChats().find(c => c.id === CHAT)?.unreadCount ?? null, null);
  phoneRead(kakao);
  fake.emit('message', { chatId: CHAT, messageId: '100', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
  assert.equal(kakao.listChats().find(c => c.id === CHAT)?.unreadCount, 1);
});


test('an omitted invalid-count flag preserves an explicit numeric count, never an absent or malformed count', async () => {
  for (const [extra, confirmed, serverUnreadCount] of [
    [{ newMessageCount: 0 }, true, 0],
    [{ newMessageCount: 1 }, false, 1],
    [{}, false, null],
    [{ newMessageCount: null }, false, null],
    [{ newMessageCount: '0' }, false, null],
    [{ newMessageCount: -1 }, false, null],
    [{ newMessageCount: 0, invalidNewMessageCount: true }, false, null],
    [{ newMessageCount: 0, invalidNewMessageCount: null }, false, null]
  ] as const) {
    const { kakao, fake } = setup(); phoneRead(kakao);
    fake.replies.request = [
      { header: { status: 0 }, data: { chatDatas: [] } },
      { header: { status: 0 }, data: { chatInfo: { chatId: CHAT, ...extra } } }
    ];
    const result = await kakao.inspectRoomReadState(CHAT);
    assert.equal(result.confirmed, confirmed);
    assert.equal(result.serverUnreadCount, serverUnreadCount);
  }
});

test('trust message watches are idle and receipt-free signals, while actual deliveries keep their budget', async () => {
  const { kakao, fake } = setup({ KAKAO_AGENT_MODE: 'trust' }); phoneRead(kakao);
  kakao.setRoomAccess(CHAT, { mode: 'immediate', callsPerHour: 1 });
  const changes: Array<string | undefined> = [];
  const stop = await kakao.watchRoomMessages(CHAT, code => changes.push(code));
  fake.emit('read', { chatId: CHAT, userId: '42', watermark: '100' });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(changes, []);
  fake.emit('message', { chatId: CHAT, messageId: '101', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(changes, [undefined]);
  await kakao.recentMessages(0, CHAT); await assert.rejects(kakao.recentMessages(0, CHAT), isCode('RATE_LIMITED'));
  kakao.setRoomAccess(CHAT, { mode: 'deny' }); assert.equal(changes.at(-1), 'POLICY_DENIED');
  const count = changes.length; fake.emit('message', { chatId: CHAT, messageId: '102', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(changes.length, count); stop();
});

test('ask message watches signal a newly unread message in an approved room', async () => {
  const { kakao, fake } = setup(); phoneRead(kakao);
  const changes: Array<string | undefined> = [];
  const stop = await kakao.watchRoomMessages(CHAT, code => changes.push(code));
  fake.emit('message', { chatId: CHAT, messageId: '101', authorId: '42', text: 'fixture', type: 1, sendAt: 1, raw: {} });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(changes, [undefined]); stop();
});

test('expiring watch authorization is rechecked without another content request', async () => {
  const { kakao, fake } = setup({ KAKAO_AGENT_MODE: 'trust' }); phoneRead(kakao);
  kakao.setRoomAccess(CHAT, { mode: 'immediate', expiresAt: new Date(Date.now() + 500).toISOString() });
  const changes: Array<string | undefined> = [];
  const stop = await kakao.watchRoomMessages(CHAT, code => changes.push(code));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(changes, ['POLICY_DENIED']); assert.equal(fake.calls.length, 0); stop();
});


test('room departure stops a trust subscription and unknown rooms cannot be watched', async () => {
  const { kakao, fake } = setup({ KAKAO_AGENT_MODE: 'trust' }); phoneRead(kakao);
  await assert.rejects(kakao.watchRoomMessages('111', () => {}), isCode('NOT_FOUND'));
  const changes: Array<string | undefined> = [];
  const stop = await kakao.watchRoomMessages(CHAT, code => changes.push(code));
  fake.emit('packet', { header: { id: 0, status: 0, method: 'LEFT' }, data: { chatId: CHAT } });
  assert.deepEqual(changes, ['NOT_FOUND']); stop();
});

test('a send carries the caller\'s client message ID, and a local storage failure after it never fails the send', async () => {
  const lines: string[] = [];
  const { kakao, fake } = setup({}, [], true, line => lines.push(line)); fake.connect();
  fake.replies.sendText = [{ status: 0, logId: '9007199254740993', raw: {} }];
  (kakao as any).ingest = () => { throw new KakaoError('INTERNAL', 'fixture storage failure'); };
  const res = await kakao.sendMessage(CHAT, 'fixture', { msgId: 4242 });
  assert.equal(res.logId, '9007199254740993');
  assert.deepEqual(fake.calls.find(c => c.method === 'sendText')!.args, [CHAT, 'fixture', { msgId: 4242 }]);
  assert.ok(lines.some(l => l === 'sent message not stored locally: INTERNAL'));
});

test('findOwnMessage matches our own message by client message ID across history pages', async () => {
  const { kakao, fake } = setup(); fake.connect();
  const log = (messageId: string, authorId: string, msgId: unknown) => ({ chatId: CHAT, messageId, authorId, type: 1, text: 'fixture', sendAt: 1, raw: { msgId } });
  fake.replies.chatLogs = [
    { status: 0, messages: [log('8001', '42', 77), log('8002', SELF, 76)], eof: false, raw: {} },
    { status: 0, messages: [log('8003', SELF, Long.fromNumber(77))], eof: true, raw: {} }
  ];
  assert.deepEqual(await kakao.findOwnMessage(CHAT, 77, '8000'), { found: true, logId: '8003' }, 'another member\'s message with the same ID never matches');
  const sinces = fake.calls.filter(c => c.method === 'chatLogs').map(c => c.args[1]);
  assert.deepEqual(sinces, [['8000'], ['8002']]);
  fake.replies.chatLogs = [{ status: 0, messages: [log('8004', SELF, 1)], eof: true, raw: {} }];
  assert.deepEqual(await kakao.findOwnMessage(CHAT, 77, '8003'), { found: false, complete: true });
  fake.replies.chatLogs = [{ status: 0, messages: [log('8005', SELF, 1)], eof: false, raw: {} }];
  assert.deepEqual(await kakao.findOwnMessage(CHAT, 77, '8004', 1), { found: false, complete: false });
  fake.replies.chatLogs = [{ status: -500, messages: [], eof: true, raw: {} }];
  await assert.rejects(kakao.findOwnMessage(CHAT, 77, '8005'), { code: 'LOCO_STATUS' });
});
