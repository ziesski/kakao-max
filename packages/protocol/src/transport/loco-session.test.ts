import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON } from 'bson';
import { LocoSession, MediaType, ChatMetaType } from './loco-session.js';
import { parseEmoticonAttachment, parseLoginList } from './loco-parse.js';

/** Instantiate a session and capture the LOCO request it would send, without any socket. */
function captureRequest() {
  const session = new LocoSession();
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  // override the transport: record the request and return a success packet
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return { header: { status: 0 }, data: { status: 0, logId: BSON.Long.fromNumber(999), msgId: 7 } };
  };
  return { session, calls };
}

test('deleteMessage sends DELETEMSG with chatId + logId as Long', async () => {
  const { session, calls } = captureRequest();
  const res = await session.deleteMessage('123', '456');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETEMSG');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId), 'chatId is a Long');
  assert.ok(BSON.Long.isLong(calls[0].body.logId), 'logId is a Long');
  assert.equal(calls[0].body.chatId.toString(), '123');
  assert.equal(calls[0].body.logId.toString(), '456');
  assert.equal(res.status, 0);
});

test('sendReply sends a type-26 WRITE whose extra carries the reply attachment', async () => {
  const { session, calls } = captureRequest();
  const res = await session.sendReply('100', 'thanks!', { logId: '555', userId: '42', type: 1, message: 'hi there' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'WRITE');
  assert.equal(calls[0].body.msg, 'thanks!');
  assert.equal(calls[0].body.type, 26);
  const attach = JSON.parse(calls[0].body.extra);
  assert.equal(attach.src_linkId, 0);
  assert.equal(attach.src_logId, 555);
  assert.equal(attach.src_userId, 42);
  assert.equal(attach.src_type, 1);
  assert.equal(attach.src_message, 'hi there');
  assert.equal(res.status, 0);
  assert.equal(res.logId, '999');
});

test('sendReply defaults src_type to 1 when omitted', async () => {
  const { session, calls } = captureRequest();
  await session.sendReply('100', 'ok', { logId: '1', userId: '2' });
  const attach = JSON.parse(calls[0].body.extra);
  assert.equal(attach.src_type, 1);
  assert.equal(attach.src_linkId, 0);
});

test('ship sends SHIP with chatId (Long), size (Long), type, checksum, ext', async () => {
  const { session, calls } = captureRequest();
  await session.ship('77', { size: 2048, type: MediaType.Photo, checksum: 'abc123', ext: 'jpg' });
  assert.equal(calls[0].method, 'SHIP');
  assert.ok(BSON.Long.isLong(calls[0].body.c));
  assert.equal(calls[0].body.c.toString(), '77');
  assert.ok(BSON.Long.isLong(calls[0].body.s));
  assert.equal(calls[0].body.s.toString(), '2048');
  assert.equal(calls[0].body.t, MediaType.Photo);
  assert.equal(calls[0].body.cs, 'abc123');
  assert.equal(calls[0].body.e, 'jpg');
});

test('sendMediaPost sends POST with the full 18-field body', async () => {
  const { session, calls } = captureRequest();
  await session.sendMediaPost({
    chatId: '10',
    userId: '42',
    token: 'uptoken',
    type: MediaType.Photo,
    size: 9999,
    fileName: 'pic.jpg',
    width: 800,
    height: 600
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.k, 'uptoken');
  assert.equal(calls[0].body.t, MediaType.Photo);
  assert.ok(BSON.Long.isLong(calls[0].body.s));
  assert.equal(calls[0].body.s.toString(), '9999');
  assert.equal(calls[0].body.w, 800);
  assert.equal(calls[0].body.h, 600);
  assert.equal(calls[0].body.f, 'pic.jpg');
  assert.ok(BSON.Long.isLong(calls[0].body.c));
  assert.equal(calls[0].body.c.toString(), '10');
  assert.ok(BSON.Long.isLong(calls[0].body.u));
  assert.equal(calls[0].body.u.toString(), '42');
  assert.equal(calls[0].body.mm, '999');
  assert.equal(calls[0].body.av, '26.4.0');
  assert.equal(calls[0].body.os, 'mac');
  assert.equal(calls[0].body.scp, 1);
});

test('getTrailer sends GETTRAILER with token + type', async () => {
  const { session, calls } = captureRequest();
  await session.getTrailer('dltoken', MediaType.File);
  assert.equal(calls[0].method, 'GETTRAILER');
  assert.equal(calls[0].body.k, 'dltoken');
  assert.equal(calls[0].body.t, MediaType.File);
});

test('malformed media allocation errors never include provider response fields', async () => {
  for (const kind of ['download', 'upload']) {
    const session = new LocoSession();
    (session as any).request = async () => ({ header: { status: 0 },
      data: { status: 0, k: 'fixture-private-media-token', extra: 'fixture-private-upstream-body' } });
    const effect = kind === 'download'
      ? session.downloadMedia('123', { userId: '42', token: 'fixture', type: 2 })
      : session.uploadMedia('123', { userId: '42', data: new Uint8Array([1]), type: 2 });
    await assert.rejects(effect, (error: unknown) => {
      assert.equal((error as { code: string }).code, 'MALFORMED');
      assert.match((error as Error).message, /missing/);
      assert.equal((error as Error).message.includes('fixture-private'), false);
      return true;
    });
  }
});

test('leave sends LEAVE with chatId (Long), block, silence', async () => {
  const { session, calls } = captureRequest();
  await session.leave('321', { silence: true });
  assert.equal(calls[0].method, 'LEAVE');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId));
  assert.equal(calls[0].body.chatId.toString(), '321');
  assert.equal(calls[0].body.block, false);
  assert.equal(calls[0].body.silence, true);
});

test('leave defaults block + silence to false', async () => {
  const { session, calls } = captureRequest();
  await session.leave('1');
  assert.equal(calls[0].body.block, false);
  assert.equal(calls[0].body.silence, false);
});

test('setMeta sends SETMETA with chatId (Long), numeric type, JSON-stringified content', async () => {
  const { session, calls } = captureRequest();
  await session.setMeta('55', ChatMetaType.Notice, { content: 'hello notice' });
  assert.equal(calls[0].method, 'SETMETA');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId));
  assert.equal(calls[0].body.type, ChatMetaType.Notice);
  assert.equal(calls[0].body.content, JSON.stringify({ content: 'hello notice' }));
});

test('setMeta passes a string content through unchanged', async () => {
  const { session, calls } = captureRequest();
  await session.setMeta('55', 3, 'raw-string');
  assert.equal(calls[0].body.content, 'raw-string');
});

test('getMeta sends GETMETA with chatId (Long) + numeric types array', async () => {
  const { session, calls } = captureRequest();
  await session.getMeta('77', [ChatMetaType.Notice, ChatMetaType.Title]);
  assert.equal(calls[0].method, 'GETMETA');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId));
  assert.deepEqual(calls[0].body.types, [ChatMetaType.Notice, ChatMetaType.Title]);
});

test('forwardMessage sends FORWARD with chatId (Long), type, msg, extra', async () => {
  const { session, calls } = captureRequest();
  await session.forwardMessage('90', { type: 1, text: 'fwd body', extra: 'X' });
  assert.equal(calls[0].method, 'FORWARD');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId));
  assert.equal(calls[0].body.type, 1);
  assert.equal(calls[0].body.msg, 'fwd body');
  assert.equal(calls[0].body.extra, 'X');
  // A plain int, as in WRITE (which works live).
  assert.equal(typeof calls[0].body.msgId, 'number');
});

test('sendWithMentions sends type-1 WRITE whose extra carries the mentions array', async () => {
  const { session, calls } = captureRequest();
  await session.sendWithMentions('5', '@Pat hi', [{ userId: '42', at: [0], len: 4 }]);
  assert.equal(calls[0].method, 'WRITE');
  assert.equal(calls[0].body.type, 1);
  const attach = JSON.parse(calls[0].body.extra);
  assert.deepEqual(attach.mentions, [{ at: [0], len: 4, user_id: 42 }]);
});

test('chatLogs sends MCHATLOGS with chatIds + sinces as Long arrays and reads eof', async () => {
  const session = new LocoSession();
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        eof: true,
        chatLogs: [{ logId: BSON.Long.fromString('9007199254740993'), chatId: BSON.Long.fromNumber(10), authorId: 7, type: 1, message: 'hi', sendAt: 1 }]
      }
    };
  };
  const res = await session.chatLogs(['10'], ['0']);
  assert.equal(calls[0].method, 'MCHATLOGS');
  assert.ok(BSON.Long.isLong(calls[0].body.chatIds[0]) && BSON.Long.isLong(calls[0].body.sinces[0]));
  assert.equal(calls[0].body.chatIds[0].toString(), '10');
  assert.equal(res.status, 0);
  assert.equal(res.eof, true);
  assert.equal(res.messages[0].messageId, '9007199254740993');
});

// --- block list tests ---
test('syncBlockList sends BLSYNC with r and pr', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        r: 10,
        f: true,
        l: [BSON.Long.fromNumber(12345), BSON.Long.fromNumber(67890)],
        ts: [1, 2]
      }
    };
  };
  const res = await session.syncBlockList({ revision: 5, plusRevision: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'BLSYNC');
  assert.equal(calls[0].body.r, 5);
  assert.equal(calls[0].body.pr, 0);
  assert.equal(res.status, 0);
  assert.equal(res.revision, 10);
  assert.equal(res.isFull, true);
  assert.deepEqual(res.blockIds, ['12345', '67890']);
  assert.deepEqual(res.blockTypes, [1, 2]);
});

test('getBlockMembers sends BLMEMBER with l and pl as Longs', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        l: [{ userId: BSON.Long.fromNumber(12345), nickName: 'UserA' }],
        ts: [1]
      }
    };
  };
  const res = await session.getBlockMembers(['12345']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'BLMEMBER');
  assert.ok(BSON.Long.isLong(calls[0].body.l[0]));
  assert.equal(calls[0].body.l[0].toString(), '12345');
  assert.equal(res.status, 0);
  assert.equal(res.members.length, 1);
  assert.equal(res.members[0].userId, '12345');
  assert.equal(res.members[0].name, 'UserA');
});

test('addBlockItem sends BLADDITEM with l as Long, ts, and fr', async () => {
  const { session, calls } = captureRequest();
  await session.addBlockItem(['12345'], [2]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'BLADDITEM');
  assert.ok(BSON.Long.isLong(calls[0].body.l[0]));
  assert.equal(calls[0].body.l[0].toString(), '12345');
  assert.deepEqual(calls[0].body.ts, [2]);
  assert.deepEqual(calls[0].body.fr, [0]);
});

test('deleteBlockItem sends BLDELITEM with l as Long', async () => {
  const { session, calls } = captureRequest();
  await session.deleteBlockItem(['12345']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'BLDELITEM');
  assert.ok(BSON.Long.isLong(calls[0].body.l[0]));
  assert.equal(calls[0].body.l[0].toString(), '12345');
});

// --- Item 1: Emoticon tests ---
test('sendEmoticon sends WRITE with correct type code and extra schema', async () => {
  const { session, calls } = captureRequest();
  await session.sendEmoticon('10', {
    emoticon: {
      name: '(미소)',
      path: 'smile.png',
      itemType: 'EMOTICON'
    }
  });
  assert.equal(calls[0].method, 'WRITE');
  assert.equal(calls[0].body.type, 6); // EMOTICON type code 6
  assert.equal(calls[0].body.msg, '(미소)');
  const parsed = JSON.parse(calls[0].body.extra);
  assert.equal(parsed.name, '(미소)');
  assert.equal(parsed.path, 'smile.png');
  assert.equal(parsed.itemType, 'EMOTICON');

  // Test STICKER (type 12) and XCON (type 25)
  calls.length = 0;
  await session.sendEmoticon('10', {
    emoticon: {
      name: '(대형이모티콘)',
      path: 'xcon.png',
      itemType: 'XCON',
      width: 300,
      height: 300,
      xconVersion: 1
    }
  });
  assert.equal(calls[0].body.type, 25);
  const xconExtra = JSON.parse(calls[0].body.extra);
  assert.equal(xconExtra.width, 300);
  assert.equal(xconExtra.xconVersion, 1);
});

// --- Item 2: Message editing (MODIFYMSG / SYNCMODMSG) ---
test('modifyMessage sends MODIFYMSG with chatId (Long), logId (Long), type, msg, extra', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        chatLog: { logId: BSON.Long.fromString('111'), chatId: BSON.Long.fromNumber(10), message: 'old' },
        modifiedChatLog: { logId: BSON.Long.fromString('111'), chatId: BSON.Long.fromNumber(10), message: 'edited' }
      }
    };
  };
  const res = await session.modifyMessage('10', '111', 'edited');
  assert.equal(calls[0].method, 'MODIFYMSG');
  assert.ok(BSON.Long.isLong(calls[0].body.chatId));
  assert.ok(BSON.Long.isLong(calls[0].body.logId));
  assert.equal(calls[0].body.msg, 'edited');
  assert.equal(res.status, 0);
  assert.equal(res.modifiedChatLog?.text, 'edited');
});

// --- Item 3: Push notices (SYNCMODMSG, SYNCDLMSG) ---
test('dispatch handles SYNCMODMSG and SYNCDLMSG pushes', (t, done) => {
  const session = new LocoSession();
  let gotMod = false;
  let gotDl = false;

  session.on('syncmodmsg', (e) => {
    assert.equal(e.chatLog.text, 'old');
    assert.equal(e.modifiedChatLog?.text, 'new');
    gotMod = true;
    if (gotMod && gotDl) done();
  });

  session.on('syncdlmsg', (e) => {
    assert.equal(e.chatLog.messageId, '999');
    gotDl = true;
    if (gotMod && gotDl) done();
  });

  // Inject SYNCMODMSG packet
  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCMODMSG' },
    data: {
      chatLog: { logId: BSON.Long.fromString('111'), chatId: BSON.Long.fromNumber(10), message: 'old' },
      modifiedChatLog: { logId: BSON.Long.fromString('111'), chatId: BSON.Long.fromNumber(10), message: 'new' }
    }
  });

  // Inject SYNCDLMSG packet
  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCDLMSG' },
    data: {
      chatLog: { logId: BSON.Long.fromString('999'), chatId: BSON.Long.fromNumber(10) }
    }
  });
});

// --- Item 5: Multi-photo sending (MSHIP, MPOST) ---
test('multiPhotoShip sends MSHIP with c, t, sl, csl, el, ex', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        kl: ['tok1', 'tok2'],
        pl: [443, 443],
        vhl: ['trailer1.kakao.com', 'trailer2.kakao.com'],
        mtl: ['image/jpeg', 'image/jpeg']
      }
    };
  };
  const res = await session.multiPhotoShip('10', [
    { size: 1000, checksum: 'cs1', ext: 'jpg' },
    { size: 2000, checksum: 'cs2', ext: 'jpg' }
  ]);
  assert.equal(calls[0].method, 'MSHIP');
  assert.ok(BSON.Long.isLong(calls[0].body.c));
  assert.equal(calls[0].body.t, 27);
  assert.ok(BSON.Long.isLong(calls[0].body.sl[0]));
  assert.deepEqual(calls[0].body.csl, ['cs1', 'cs2']);
  assert.deepEqual(res.tokenList, ['tok1', 'tok2']);
});

test('bundle publication is a single WRITE type27 with exact chat ID and attachment', async () => {
  const { session, calls } = captureRequest();
  await session.sendMultiPhotoMessage('9007199254740993', '{"kl":["tok1","tok2"]}');
  assert.equal(calls[0].method, 'WRITE');
  assert.equal(calls[0].body.chatId.toString(), '9007199254740993');
  assert.equal(calls[0].body.type, 27);
  assert.equal(calls[0].body.extra, '{"kl":["tok1","tok2"]}');
});

// --- Item 6: OpenChat link sync (SYNCLINK / SYNCLINK*) ---
test('syncLink sends SYNCLINK with ltk and parses ols, dlis, ltk', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, any>) => {
    calls.push({ method, body });
    return {
      header: { status: 0 },
      data: {
        status: 0,
        ltk: 42,
        ols: [{
          li: BSON.Long.fromString('99999'),
          lt: 10,
          ln: 'OpenChat Test',
          lu: 'https://open.kakao.com/o/test',
          vt: 1,
          ltp: 2,
          act: true,
          ca: 1600000000
        }],
        dlis: [BSON.Long.fromString('88888')]
      }
    };
  };
  const res = await session.syncLink(5);
  assert.equal(calls[0].method, 'SYNCLINK');
  assert.equal(calls[0].body.ltk, 5);
  assert.equal(res.status, 0);
  assert.equal(res.lastLinkToken, 42);
  assert.equal(res.openLinks[0].linkId, '99999');
  assert.equal(res.openLinks[0].linkName, 'OpenChat Test');
  assert.equal(res.openLinks[0].active, true);
  assert.deepEqual(res.deletedLinkIds, ['88888']);
});

test('dispatch handles SYNCLINKCR, SYNCLINKUP, SYNCLINKDL, SYNCLINKPF pushes', (t, done) => {
  const session = new LocoSession();
  let count = 0;
  const checkDone = () => { if (++count === 4) done(); };

  session.on('synclinkcr', (e) => {
    assert.equal(e.openLink.linkName, 'CreatedLink');
    checkDone();
  });
  session.on('synclinkup', (e) => {
    assert.equal(e.openLink.linkName, 'UpdatedLink');
    checkDone();
  });
  session.on('synclinkdl', (e) => {
    assert.equal(e.linkId, '555');
    checkDone();
  });
  session.on('synclinkpf', (e) => {
    assert.equal(e.chatId, '777');
    assert.equal(e.linkId, '888');
    checkDone();
  });

  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCLINKCR' },
    data: { openLink: { ln: 'CreatedLink', li: BSON.Long.fromNumber(1) } }
  });
  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCLINKUP' },
    data: { openLink: { ln: 'UpdatedLink', li: BSON.Long.fromNumber(2) } }
  });
  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCLINKDL' },
    data: { linkId: BSON.Long.fromNumber(555) }
  });
  (session as any).dispatch({
    header: { id: 0, status: 0, method: 'SYNCLINKPF' },
    data: { chatId: BSON.Long.fromNumber(777), linkId: BSON.Long.fromNumber(888) }
  });
});


test('parseEmoticonAttachment accepts the live shape without itemType, and sendEmoticonRaw passes it through', async () => {
  const live = { alt: '(이모티콘)', emoticonItemPath: 'a/b.webp', kid: [1], name: '(이모티콘)', path: '4412207.emot_001.webp' };
  const parsed = parseEmoticonAttachment(JSON.stringify(live));
  assert.equal(parsed?.itemType, undefined);
  assert.equal(parsed?.emoticonItemPath, 'a/b.webp');
  const { session, calls } = captureRequest();
  await session.sendEmoticonRaw('10', { type: 20, extra: JSON.stringify(live) });
  assert.equal(calls[0].method, 'WRITE');
  assert.equal(calls[0].body.type, 20);
  assert.deepEqual(JSON.parse(calls[0].body.extra), live);
});

test('sendWithMentions keeps a userId above 2^53 exact and refuses anything that is not a numeric id', async () => {
  const { session, calls } = captureRequest();
  await session.sendWithMentions('5', '@홍길동 hi', [{ userId: '9007199254740993', at: [1], len: 3 }]);
  assert.match(calls[0].body.extra, /"user_id":9007199254740993\}/);
  assert.deepEqual(JSON.parse(calls[0].body.extra).mentions[0].at, [1]);

  // An agent-supplied userId must not be able to inject JSON into the attachment.
  await assert.rejects(session.sendWithMentions('5', '@x', [{ userId: '1},"evil":{"a":1', at: [1], len: 1 }]), /numeric id/);
  await assert.rejects(session.sendWithMentions('5', '@x', [{ userId: '42', at: [-1], len: 1 }]), /non-negative/);
  await assert.rejects(session.sendWithMentions('5', '@x', [{ userId: '42', at: [1], len: 0 }]), /positive/);
  assert.equal(calls.length, 1, 'nothing is sent for a rejected mention');
});

test('parseLoginList reads the unread count from n (live chatData shape, 2026-10-20)', () => {
  // Keys as the live LCHATLIST/LOGINLIST chatData has them; values made up. There is no `u`.
  const [chat] = parseLoginList({ chatDatas: [{ c: 123456789, t: 'MultiChat', a: 5, n: 9, ii: 0, o: 1, jn: 0 }] });
  assert.equal(chat.unreadCount, 9);
  assert.equal(parseLoginList({ chatDatas: [{ c: 1, t: 'DirectChat', u: 2 }] })[0].unreadCount, 2);
  assert.equal(parseLoginList({ chatDatas: [{ c: 1, t: 'DirectChat' }] })[0].unreadCount, undefined);
});

test('media reuse keeps legacy callers unchanged and opt-in publication resolves only its allocated token location', async () => {
  const { session, calls } = captureRequest();
  (session as any).request = async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return { header: { status: 0 }, data: method === 'SHIP' ? { status: 0, rd: true, k: 'fixture-reuse-token' } : { status: -203 } };
  };
  const options = { userId: '123456789', data: new Uint8Array([1, 2, 3]), type: 18, fileName: 'fixture.txt' };
  assert.equal((await session.uploadMedia('987654321', options)).chatLog.logId, '');
  assert.deepEqual(calls.map(c => c.method), ['SHIP']);
  await assert.rejects(session.uploadMedia('987654321', { ...options, commitReuse: true }));
  assert.deepEqual(calls.map(c => c.method), ['SHIP', 'SHIP', 'GETTRAILER']);
  assert.equal(calls.at(-1)?.body.k, 'fixture-reuse-token');
  assert.equal(calls.some(c => c.method === 'WRITE'), false);
});

test('text WRITEs carry a caller-chosen client message ID, and refuse one that is not a positive 31-bit integer', async () => {
  const { session, calls } = captureRequest();
  await session.sendText('123', 'fixture', { msgId: 4242 });
  await session.sendReply('123', 'fixture', { logId: '456', userId: '789' }, { msgId: 4243 });
  await session.sendWithMentions('123', 'fixture', [{ userId: '789', at: [1], len: 1 }], { msgId: 4244 });
  assert.deepEqual(calls.map(c => c.body.msgId), [4242, 4243, 4244]);
  await session.sendText('123', 'fixture');
  assert.ok(Number.isInteger(calls[3].body.msgId) && calls[3].body.msgId >= 0, 'random when omitted');
  for (const msgId of [0, -1, 1.5, 0x80000000]) {
    await assert.rejects(session.sendText('123', 'fixture', { msgId }), (e: any) => e.code === 'INVALID_ARGUMENT');
  }
  assert.equal(calls.length, 4, 'an invalid ID is refused before anything is written');
});
