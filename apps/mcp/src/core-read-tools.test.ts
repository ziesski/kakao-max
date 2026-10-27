import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { KakaoDb, RoomAccessPolicy, SendPolicy } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { registerCoreReadTools, saveDownload } from './tools/core-read.ts';

const CHAT = '123456789';

function harness(t: { after(fn: () => void): void }, mode: 'ask' | 'trust' = 'ask') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-read-tool-'));
  const db = KakaoDb.open({ dir }), rooms = new RoomAccessPolicy(db);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const seen: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, value: unknown) => (...args: unknown[]) => { seen.push({ method, args }); return value; };
  const kakao = {
    getState: () => ({ connected: true, userId: '987654321' }), cursor: 0,
    getChatInfo: async (chatId: string) => ({ chatId, title: 'fixture 홍길동', titleSource: 'custom', isGroup: false, lastLogId: '9', members: [] }),
    getRoomAccess: (chatId: string) => ({ chatId, rule: rooms.rule(chatId), defaultMode: 'deny' }),
    inspectRoomReadState: record('inspectRoomReadState', Promise.resolve({ confirmed: false, reason: 'server_unread', localUnreadCount: 31, serverUnreadCount: 31 })),
    previewUnreadMessages: record('previewUnreadMessages', Promise.resolve({ source: 'local-push-store', messages: [], unreadBefore: 2, unreadAfter: 2, readReceiptSent: false })),
    getHistory: record('getHistory', Promise.resolve({ messages: [] })),
    getHistoryRange: record('getHistoryRange', Promise.resolve({ messages: [], pending: false })),
    searchMessages: record('searchMessages', Promise.resolve([])),
    recentMessages: record('recentMessages', Promise.resolve([])),
    waitForMessages: record('waitForMessages', Promise.resolve([]))
  };
  const policy = new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(dir, 'audit') });
  const server = new McpStdioServer({ name: 'test', version: '0' });
  registerCoreReadTools(server, { kakao: kakao as never, policy, config: { recipientDailyLimit: mode === 'trust' ? null : 50, addFriendDailyLimit: 10, dataDir: dir, agentMode: mode, agentModeSource: mode === 'trust' ? 'setting' : 'default', approval: { clientConfirm: true, notify: false, windowMinutes: 15, actionWindowMinutes: {} } },
    groups: [], grants: () => undefined });
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.end(); output.end(); });
  let id = 0, text = '';
  const pending = new Map<number, (value: any) => void>();
  output.on('data', chunk => {
    text += chunk.toString(); let n;
    while ((n = text.indexOf('\n')) >= 0) {
      const r = JSON.parse(text.slice(0, n)); text = text.slice(n + 1);
      pending.get(r.id)?.(r.result); pending.delete(r.id);
    }
  });
  server.serveConnection(input, output);
  const call = (name: string, args: Record<string, unknown>) => new Promise<any>(resolve => {
    const next = ++id; pending.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const code = (r: any) => r.structuredContent?.error?.code;
  return { call, code, rooms, seen };
}

test('list_chats shows one room\'s access rule and fresh read state as metadata only', async t => {
  const h = harness(t);
  const detail = JSON.parse((await h.call('list_chats', { chatId: CHAT })).content[0].text);
  assert.equal(detail.access.rule.mode, 'deny'); assert.equal(detail.untrusted, true); assert.equal(detail.readState, undefined);
  assert.equal(h.seen.length, 0);
  const fresh = JSON.parse((await h.call('list_chats', { chatId: CHAT, refreshReadState: true })).content[0].text);
  assert.equal(fresh.readState.serverUnreadCount, 31);
  assert.deepEqual(h.seen.map(s => s.method), ['inspectRoomReadState']);
  for (const bad of [{ refreshReadState: true }, { chatId: CHAT, unreadOnly: true }]) assert.equal(h.code(await h.call('list_chats', bad)), 'INVALID_ARGUMENT');
});

test('read_messages keeps each mode\'s arguments apart and passes only a read grant reference', async t => {
  const h = harness(t);
  await h.call('read_messages', { chatId: CHAT, readGrantId: 'fixture-grant' });
  assert.deepEqual(h.seen.at(-1), { method: 'getHistory', args: [CHAT, { max: undefined, cur: undefined, limit: 50, readGrant: { id: 'fixture-grant', tool: 'read_messages' } }] });
  await h.call('read_messages', { chatId: CHAT, from: '2026-10-23T00:00:00+09:00', to: '2026-10-24T00:00:00+09:00' });
  assert.equal(h.seen.at(-1)!.method, 'getHistoryRange');
  await h.call('read_messages', { chatId: CHAT, query: 'fixture' });
  assert.equal(h.seen.at(-1)!.method, 'searchMessages');
  await h.call('read_messages', { chatId: CHAT, mode: 'wait', sinceSeq: 3, timeoutMs: 1000 });
  assert.deepEqual(h.seen.at(-1), { method: 'waitForMessages', args: [3, 1000, CHAT, {}] });
  const calls = h.seen.length;
  for (const bad of [{ mode: 'recent', query: 'x' }, { mode: 'search' }, { from: '2026-10-23T00:00:00+09:00' }, { from: 'a', to: 'b', beforeLogId: '1' },
    { mode: 'history', timeoutMs: 1000 }, { confirmRead: true }]) {
    assert.equal(h.code(await h.call('read_messages', { chatId: CHAT, ...bad })), 'INVALID_ARGUMENT', JSON.stringify(bad));
  }
  assert.equal(h.seen.length, calls);
});

test('preview_unread needs a read grant covering preview_unread and never accepts an agent confirmRead', async t => {
  const h = harness(t);
  assert.equal(h.code(await h.call('preview_unread', { chatId: CHAT })), 'INVALID_ARGUMENT');
  assert.equal(h.code(await h.call('preview_unread', { chatId: CHAT, confirmRead: true, readGrantId: 'fixture-grant' })), 'INVALID_ARGUMENT');
  const preview = await h.call('preview_unread', { chatId: CHAT, readGrantId: 'fixture-grant', limit: 2 });
  assert.equal(preview.isError, false); assert.equal(JSON.parse(preview.content[0].text).untrusted, true);
  assert.deepEqual(h.seen.at(-1), { method: 'previewUnreadMessages', args: [CHAT, { readGrant: { id: 'fixture-grant', tool: 'preview_unread' } }, 2] });
});

test('get_status shows the agent mode and its policy defaults', async t => {
  const ask = JSON.parse((await harness(t).call('get_status', {})).content[0].text);
  assert.deepEqual(ask.agentMode, { mode: 'ask', source: 'default' });
  assert.equal(ask.policy.roomContentDefault, 'deny'); assert.equal(ask.policy.sendRoomDailyLimit, 50);
  const trust = JSON.parse((await harness(t, 'trust').call('get_status', {})).content[0].text);
  assert.deepEqual(trust.agentMode, { mode: 'trust', source: 'setting' });
  assert.equal(trust.policy.roomContentDefault, 'allow'); assert.equal(trust.policy.sendRoomDailyLimit, null);
});

test('download_attachment never writes to an agent-chosen path; save=true stays in the daemon downloads folder', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = new TextEncoder().encode('fixture attachment');
  const saved = await saveDownload(dir, CHAT, '42', bytes);
  assert.ok(saved.startsWith(path.join(dir, 'downloads', CHAT) + path.sep));
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  assert.equal(await saveDownload(dir, CHAT, '42', bytes), saved, 'saving the same bytes again is idempotent');
  for (const [chat, message] of [['../etc', '42'], [CHAT, '../../.env.local']]) await assert.rejects(saveDownload(dir, chat, message, bytes), { code: 'INVALID_ARGUMENT' });
  const h = harness(t);
  assert.equal(h.code(await h.call('download_attachment', { chatId: CHAT, messageId: '42', token: 'k', outputPath: path.join(dir, 'x') })), 'INVALID_ARGUMENT');
  assert.equal(fs.existsSync(path.join(dir, 'x')), false);
});
