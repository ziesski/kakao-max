import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoomSmokeAccess } from './smoke-read-scope.ts';

test('smoke never requests room history or search when unread state is positive, unknown or absent', async () => {
  let calls = 0;
  for (const chats of [[], [{ id: '123456789', unreadCount: 1 }],
    [{ id: '123456789', unreadCount: null }], [{ id: '123456789' }]]) {
    const access = readRoomSmokeAccess({ getState: async () => ({ chats }),
      getHistory: async () => { calls++; }, searchMessages: async () => { calls++; } });
    await assert.rejects(access.history('123456789', 20), /explicit unreadCount=0/);
    await assert.rejects(access.search('synthetic', '123456789', 100), /explicit unreadCount=0/);
  }
  assert.equal(calls, 0);
});

test('smoke scopes search to the selected read room and rechecks state before every operation', async () => {
  let unreadCount = 0, checks = 0;
  const calls: unknown[] = [];
  const access = readRoomSmokeAccess({
    getState: async () => { checks++; return { chats: [{ id: '123456789', unreadCount }] }; },
    getHistory: async (...args) => { calls.push(['history', ...args]); return { messages: [] }; },
    searchMessages: async (...args) => { calls.push(['search', ...args]); return { count: 0 }; }
  });
  await access.history('123456789', 20);
  await access.search('synthetic', '123456789', 100);
  assert.deepEqual(calls, [['history', '123456789', 20], ['search', 'synthetic', '123456789', 100]]);
  unreadCount = 1;
  await assert.rejects(access.history('123456789', 20));
  await assert.rejects(access.search('synthetic', '123456789', 100));
  assert.equal(checks, 4);
  assert.equal(calls.length, 2, 'state changes fail closed without a global-search fallback');
});
