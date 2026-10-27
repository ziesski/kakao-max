import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { removeTestDir } from './temp-dir.test-helper.ts';
import path from 'node:path';
import os from 'node:os';
import type { SyncResult } from '@kakao-max/protocol';
import { MessageStore } from './message-store.ts';
import { KakaoDb } from './db.ts';
import { backfillHistory, mchatLogsSource, type SyncSource } from './history-sync.ts';

const CHAT = '900';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-sync-'));
  return { store: new MessageStore(KakaoDb.open({ dir })), dir };
}

/** A stub server holding logs 1..n for CHAT; serves SYNCMSG (cur, max] pages like LOCO. */
function stubSource(n: number, opts: { status?: number } = {}) {
  const calls: Array<{ cur?: string | number; max?: string | number; count?: number }> = [];
  const source: SyncSource = {
    async syncMessages(chatId, o) {
      calls.push(o);
      if (opts.status != null) return { status: opts.status, messages: [], hasMore: false, raw: {} };
      const cur = BigInt(o.cur ?? 0);
      const max = BigInt(o.max ?? 0);
      const all = Array.from({ length: n }, (_, i) => BigInt(i + 1)).filter((id) => id > cur && id <= max);
      const page = all.slice(0, o.count ?? 30);
      const res: SyncResult = {
        status: 0,
        messages: page.map((id) => ({
          chatId,
          messageId: String(id),
          authorId: '7',
          type: 1,
          text: `log ${id}`,
          sendAt: 1_700_000_000 + Number(id),
          raw: {}
        })),
        hasMore: all.length > page.length,
        raw: page.length ? { lastTokenId: String(page[page.length - 1]) } : {}
      };
      return res;
    }
  };
  return { source, calls };
}

test('empty store: pages SYNCMSG from cur=0 with hasMore and persists every log', async () => {
  const { store, dir } = tmpStore();
  const { source, calls } = stubSource(120);
  const r = await backfillHistory({ source, store }, CHAT, { max: '120', limit: 20, pageSize: 50 });
  assert.equal(r.mode, 'full');
  assert.equal(r.pages, 3);
  assert.equal(r.fetched, 120);
  assert.equal(r.inserted, 120);
  assert.deepEqual(calls.map((c) => String(c.cur)), ['0', '50', '100']);
  assert.ok(calls.every((c) => String(c.max) === '120'));
  const latest = store.getMessages(CHAT, { limit: 20 });
  assert.equal(latest.length, 20);
  assert.equal(latest[latest.length - 1].text, 'log 120');
  assert.equal(latest[0].messageId, '101');
  await store.close();
  removeTestDir(dir);
});

test('dedupes on messageId: a second full backfill inserts nothing new', async () => {
  const { store, dir } = tmpStore();
  const { source } = stubSource(10);
  await backfillHistory({ source, store }, CHAT, { max: '10', limit: 50 });
  const again = await backfillHistory({ source, store }, CHAT, { max: '10', limit: 50 });
  assert.equal(again.fetched, 10);
  assert.equal(again.inserted, 0);
  assert.equal(store.getMessages(CHAT, { limit: 100 }).length, 10);
  // Persisted to disk once per message.
  await store.close();
  const reloaded = new MessageStore(KakaoDb.open({ dir }));
  assert.equal(reloaded.getMessages(CHAT, { limit: 100 }).length, 10);
  await reloaded.close();
  removeTestDir(dir);
});

test('enough stored messages: only fetches the gap after the newest stored log', async () => {
  const { store, dir } = tmpStore();
  const { source, calls } = stubSource(30);
  await backfillHistory({ source, store }, CHAT, { max: '25', limit: 10 });
  calls.length = 0;
  const r = await backfillHistory({ source, store }, CHAT, { max: '30', limit: 10 });
  assert.equal(r.mode, 'gap');
  assert.equal(String(calls[0].cur), '25');
  assert.equal(r.inserted, 5);
  await store.close();
  removeTestDir(dir);
});

test('store already covers max: sends no SYNCMSG', async () => {
  const { store, dir } = tmpStore();
  const { source, calls } = stubSource(10);
  await backfillHistory({ source, store }, CHAT, { max: '10', limit: 5 });
  calls.length = 0;
  const r = await backfillHistory({ source, store }, CHAT, { max: '10', limit: 5 });
  assert.equal(r.mode, 'skipped');
  assert.equal(calls.length, 0);
  await store.close();
  removeTestDir(dir);
});

test('unknown max (0): skips instead of asking for an empty window', async () => {
  const { store, dir } = tmpStore();
  const { source, calls } = stubSource(10);
  const r = await backfillHistory({ source, store }, CHAT, { max: '0', limit: 5 });
  assert.equal(r.mode, 'skipped');
  assert.match(r.reason ?? '', /max=0/);
  assert.equal(calls.length, 0);
  await store.close();
  removeTestDir(dir);
});

test('server error status is reported, nothing stored or invented', async () => {
  const { store, dir } = tmpStore();
  const { source } = stubSource(10, { status: -203 });
  const r = await backfillHistory({ source, store }, CHAT, { max: '10', limit: 5 });
  assert.equal(r.status, -203);
  assert.equal(r.inserted, 0);
  assert.equal(store.getMessages(CHAT).length, 0);
  await store.close();
  removeTestDir(dir);
});

test('a thrown SYNCMSG error is captured in the report', async () => {
  const { store, dir } = tmpStore();
  const source: SyncSource = { syncMessages: async () => { throw new Error('session not connected'); } };
  const r = await backfillHistory({ source, store }, CHAT, { max: '10', limit: 5 });
  assert.equal(r.error, 'session not connected');
  assert.equal(r.pages, 0);
  await store.close();
  removeTestDir(dir);
});

test('stops at maxPages and ignores logs for other chats', async () => {
  const { store, dir } = tmpStore();
  const calls: number[] = [];
  const source: SyncSource = {
    async syncMessages(_chatId, o) {
      const cur = Number(o.cur ?? 0);
      calls.push(cur);
      return {
        status: 0,
        messages: [
          { chatId: CHAT, messageId: String(cur + 1), authorId: '1', type: 1, text: 'mine', sendAt: cur + 1, raw: {} },
          { chatId: '111', messageId: `x${cur}`, authorId: '1', type: 1, text: 'other', sendAt: cur + 1, raw: {} }
        ],
        hasMore: true,
        raw: { lastTokenId: String(cur + 1) }
      };
    }
  };
  const r = await backfillHistory({ source, store }, CHAT, { max: '1000', limit: 50, maxPages: 3 });
  assert.equal(r.pages, 3);
  assert.equal(r.inserted, 3);
  assert.equal(store.getMessages('111').length, 0);
  await store.close();
  removeTestDir(dir);
});

test('caller-supplied cur starts the window there even when the store is full', async () => {
  const { store, dir } = tmpStore();
  const { source, calls } = stubSource(40);
  await backfillHistory({ source, store }, CHAT, { max: '40', limit: 5 });
  calls.length = 0;
  const r = await backfillHistory({ source, store }, CHAT, { max: '40', limit: 5, cur: '30' });
  assert.equal(r.mode, 'full');
  assert.equal(String(calls[0].cur), '30');
  assert.equal(r.fetched, 10);
  assert.equal(r.inserted, 0);
  await store.close();
  removeTestDir(dir);
});

/** A stub MCHATLOGS server holding logs 1..n: up to `pageMax` logs after `since`, eof at the end. */
function stubChatLogs(n: number, pageMax = 80) {
  const sinces: string[] = [];
  const session = {
    async chatLogs(chatIds: (string | number)[], s: (string | number)[]) {
      sinces.push(String(s[0]));
      const since = BigInt(s[0]);
      const after = Array.from({ length: n }, (_, i) => BigInt(i + 1)).filter((id) => id > since);
      const page = after.slice(0, pageMax);
      return {
        status: 0,
        eof: page.length === after.length,
        hasMore: false,
        messages: page.map((id) => ({ chatId: String(chatIds[0]), messageId: String(id), authorId: '7', type: 1, text: `log ${id}`, sendAt: Number(id), raw: {} })),
        raw: {}
      };
    }
  };
  return { session, sinces };
}

test('mchatLogsSource pages MCHATLOGS by the last logId until eof', async () => {
  const { store, dir } = tmpStore();
  const { session, sinces } = stubChatLogs(202);
  const r = await backfillHistory({ source: mchatLogsSource(session), store }, CHAT, { max: '202', limit: 50, pageSize: 80 });
  assert.equal(r.mode, 'full');
  assert.equal(r.inserted, 202);
  assert.deepEqual(sinces, ['0', '80', '160']);
  assert.equal(store.getMessages(CHAT, { limit: 1000 }).length, 202);
  removeTestDir(dir);
});

test('mchatLogsSource keeps the (cur, max] window and the page size', async () => {
  const { store, dir } = tmpStore();
  const { session, sinces } = stubChatLogs(100);
  const r = await backfillHistory({ source: mchatLogsSource(session), store }, CHAT, { max: '45', limit: 50, pageSize: 20 });
  assert.equal(r.inserted, 45, 'nothing above max is stored');
  assert.deepEqual(sinces, ['0', '20', '40']);
  assert.equal(r.hasMore, false);
  removeTestDir(dir);
});

test('backfillHistory handles max at 2^63 - 1 without BigInt binding error', async () => {
  const { store, dir } = tmpStore();
  const { source } = stubSource(5);
  // 9223372036854775807 is 2^63 - 1 (SQLite signed 64-bit int max)
  const max = '9223372036854775807';
  const r = await backfillHistory({ source, store }, CHAT, { max, limit: 10 });
  assert.equal(r.mode, 'full');
  assert.equal(r.fetched, 5);
  removeTestDir(dir);
});

test('backfillHistory without max: queries gap starting from newestStored and fires onMessage', async () => {
  const { store, dir } = tmpStore();
  const { session, sinces } = stubChatLogs(25);
  // Pre-populate store with logs 1..20
  await backfillHistory({ source: mchatLogsSource(session), store }, CHAT, { max: '20', limit: 20 });
  assert.equal(store.getMessages(CHAT, { limit: 50 }).length, 20);

  sinces.length = 0;
  const notified: string[] = [];
  // Call without max: should detect newestStored=20, query gap from 20, fetch logs 21..25
  const r = await backfillHistory(
    {
      source: mchatLogsSource(session),
      store,
      onMessage: (m) => notified.push(m.messageId)
    },
    CHAT,
    { limit: 20 }
  );

  assert.equal(r.mode, 'gap');
  assert.equal(r.cur, '20');
  assert.equal(r.inserted, 5);
  assert.deepEqual(sinces, ['20']);
  assert.deepEqual(notified, ['21', '22', '23', '24', '25']);
  assert.equal(store.getMessages(CHAT, { limit: 50 }).length, 25);
  removeTestDir(dir);
});

test('backfillHistory without max: empty store performs full sync from cur=0', async () => {
  const { store, dir } = tmpStore();
  const { session, sinces } = stubChatLogs(15);
  const r = await backfillHistory({ source: mchatLogsSource(session), store }, CHAT, { limit: 20 });
  assert.equal(r.mode, 'full');
  assert.equal(r.cur, '0');
  assert.equal(r.inserted, 15);
  assert.deepEqual(sinces, ['0']);
  assert.equal(store.getMessages(CHAT, { limit: 50 }).length, 15);
  removeTestDir(dir);
});
