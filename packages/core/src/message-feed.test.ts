import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFeed } from './message-feed.ts';

const m = (chatId: string, text: string) => ({ chatId, authorId: '2', text, type: 1, sendAt: 1, raw: {} });

test('push assigns increasing seq; recent filters by cursor and chat', () => {
  const f = new MessageFeed();
  assert.equal(f.cursor, 0);
  f.push(m('a', '1'));
  f.push(m('b', '2'));
  f.push(m('a', '3'));
  assert.equal(f.cursor, 3);
  assert.deepEqual(f.recent(1).map((x) => x.text), ['2', '3']);
  assert.deepEqual(f.recent(0, 'a').map((x) => x.seq), [1, 3]);
});

test('ring buffer keeps only the newest `max` events', () => {
  const f = new MessageFeed(2);
  for (const t of ['1', '2', '3']) f.push(m('a', t));
  assert.deepEqual(f.recent().map((x) => x.text), ['2', '3']);
});

test('read receipts become type -1 events; incomplete ones are ignored', () => {
  const f = new MessageFeed();
  assert.equal(f.pushReadReceipt({ chatId: 'a', watermark: '', userId: '2' } as any), undefined);
  const r = f.pushReadReceipt({ chatId: 'a', watermark: '99', userId: '2' } as any);
  assert.equal(r?.type, -1);
  assert.deepEqual(r?.raw, { isReadReceipt: true, watermark: '99', userId: '2' });
});

test('wait resolves immediately, on a matching push, or empty on timeout', async () => {
  const f = new MessageFeed();
  f.push(m('a', 'old'));
  assert.equal((await f.wait(0, 1000)).length, 1);

  const pending = f.wait(f.cursor, 1000, 'b');
  f.push(m('a', 'other chat'));
  f.push(m('b', 'mine'));
  assert.deepEqual((await pending).map((x) => x.text), ['mine']);

  const t0 = Date.now();
  assert.deepEqual(await f.wait(f.cursor, 30), []);
  assert.ok(Date.now() - t0 >= 25);
});
