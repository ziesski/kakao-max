import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { McpStdioServer } from './mcp-stdio.ts';
import { registerMessageResources } from './message-resources.ts';
import { McpClient } from '../../cli/src/mcp-client.ts';
import { McpConversationReader, Conversation } from '@kakao-max/client';
import { KakaoError } from '@kakao-max/core';

const URI = 'kakao://rooms/2/messages';
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
async function fixture(t: any) {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  let paused = false, allowed = true, reads = 0, seq = 0, subscribers = 0, raceHistory = false;
  const listeners = new Set<(code?: string) => void>(), pauses = new Set<() => void>();
  let messages: any[] = [{ messageId: '10', authorId: '1', text: 'fixture history' }];
  const push = () => { messages = [...messages, { messageId: String(11 + seq), authorId: '1', text: 'fixture new', seq: ++seq }]; for (const cb of listeners) cb(); };
  const check = () => { if (!allowed) throw new KakaoError('POLICY_DENIED', 'fixture denied'); };
  registerMessageResources(server, {
    async authorizeMessageWatch() { check(); },
    async watchRoomMessages(_chatId, changed) { check(); subscribers++; listeners.add(changed); return () => { if (listeners.delete(changed)) subscribers--; }; }
  }, { isPaused: () => paused, withinCeiling: id => id === '2', onPauseChanged(cb) { pauses.add(cb); return () => { pauses.delete(cb); }; } });
  server.registerTool({ name: 'get_status', description: 'fixture', inputSchema: { type: 'object' }, handler: () => ({ connected: true, userId: '1', agentMode: { mode: 'trust' } }) });
  server.registerTool({ name: 'list_chats', description: 'fixture', inputSchema: { type: 'object' }, handler: a => a.chatId ? { readState: { confirmed: true } } : { chats: [{ id: '2', title: 'fixture' }] } });
  server.registerTool({ name: 'read_messages', description: 'fixture', inputSchema: { type: 'object' }, handler: a => {
    check(); reads++;
    if (a.mode === 'recent') return { cursor: seq, messages: messages.filter(m => (m.seq ?? 0) > a.sinceSeq) };
    const result = { messages: [...messages], liveCursor: seq };
    if (raceHistory) { raceHistory = false; queueMicrotask(push); }
    return result;
  } });
  const sockets = new Set<net.Socket>();
  const srv = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); server.serveConnection(socket, socket); });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  const c = new McpClient({ host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port }); await c.connect();
  t.after(() => { c.close(); for (const socket of sockets) socket.destroy(); srv.close(); });
  return { c, reads: () => reads, subscribers: () => subscribers,
    push, race() { raceHistory = true; },
    pause() { paused = true; for (const cb of [...pauses]) cb(); },
    deny() { allowed = false; for (const cb of [...listeners]) cb('POLICY_DENIED'); },
    drop() { for (const socket of sockets) socket.destroy(); }
  };
}

test('room resource signals update a conversation without idle reads and release subscriptions on close', async t => {
  const f = await fixture(t), reader = new McpConversationReader(f.c);
  const conversation = new Conversation(reader, { identity: () => reader.status(), async send() { assert.fail('no write'); } }, () => {});
  await conversation.start(); await conversation.open('2'); await settle();
  const idleReads = f.reads(); await settle(); assert.equal(f.reads(), idleReads);
  assert.equal(f.subscribers(), 1);
  f.push(); await settle();
  assert.deepEqual(conversation.messages.map(m => m.messageId), ['10', '11']);
  assert.equal(f.reads(), idleReads + 1);
  conversation.close(); await settle(); assert.equal(f.subscribers(), 0);
});

test('pause and revocation stop signals and clear the authorized view', async t => {
  const f = await fixture(t), reader = new McpConversationReader(f.c);
  const conversation = new Conversation(reader, { identity: () => reader.status(), async send() { assert.fail('no write'); } }, () => {});
  await conversation.start(); await conversation.open('2'); await settle(); f.pause(); await settle();
  assert.equal(conversation.live, false); assert.deepEqual(conversation.messages, []); assert.equal(f.subscribers(), 0);
  conversation.close();
});

test('resource subscriptions require initialization, exact room URIs, a ceiling and a bounded connection scope', async t => {
  const f = await fixture(t);
  const templates = await f.c.request('resources/templates/list'); assert.equal(templates.resourceTemplates.length, 1);
  await assert.rejects(f.c.request('resources/subscribe', { uri: 'kakao://rooms/3/messages' }), { code: 'POLICY_DENIED' });
  await assert.rejects(f.c.request('resources/subscribe', { uri: URI + '?other=1' }), { code: 'INVALID_ARGUMENT' });
  const r = await f.c.request('resources/subscribe', { uri: URI }); assert.ok(r._meta.subscriptionId);
  await assert.rejects(f.c.request('resources/subscribe', { uri: 'kakao://rooms/4/messages' }), { code: 'RATE_LIMITED' });
  const notifications: any[] = []; f.c.onNotification((method, params) => notifications.push({ method, params }));
  f.push(); await settle();
  assert.equal(notifications.length, 1); assert.equal(notifications[0].method, 'notifications/resources/updated');
  assert.ok(!JSON.stringify(notifications).includes('fixture new'));
  f.drop(); await settle(); assert.equal(f.subscribers(), 0);
});

test('reconnect rechecks identity and catches up a bounded history without sending', async t => {
  const f = await fixture(t), reader = new McpConversationReader(f.c);
  const conversation = new Conversation(reader, { identity: () => reader.status(), async send() { assert.fail('no write'); } }, () => {});
  await conversation.start(); await conversation.open('2'); await settle(); f.drop(); await settle();
  assert.equal(conversation.live, false); assert.equal(conversation.messages.length, 1);
  f.push(); await f.c.connect(); await conversation.start(); await conversation.refresh(); await settle();
  assert.deepEqual(conversation.messages.map(m => m.messageId), ['10', '11']); assert.equal(f.subscribers(), 1);
  conversation.close();
});

test('permission revocation stops and clears an existing subscription before any further content read', async t => {
  const f = await fixture(t), reader = new McpConversationReader(f.c);
  const conversation = new Conversation(reader, { identity: () => reader.status(), async send() { assert.fail('no write'); } }, () => {});
  await conversation.start(); await conversation.open('2'); await settle();
  const before = f.reads(); f.deny(); await settle(); f.push(); await settle();
  assert.equal(conversation.live, false); assert.deepEqual(conversation.messages, []);
  assert.equal(f.reads(), before); assert.equal(f.subscribers(), 0); conversation.close();
});

test('unsubscribing during async authorization cleans up a late subscription', async t => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  let finish!: () => void, started = false, stopped = 0;
  server.setResourceSubscriptions({ templates: [], async read() { return {}; }, async subscribe() {
    started = true; await new Promise<void>(resolve => { finish = resolve; }); return () => { stopped++; };
  } });
  const sockets = new Set<net.Socket>();
  const srv = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); server.serveConnection(socket, socket); });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  const c = new McpClient({ host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port }); await c.connect();
  t.after(() => { c.close(); for (const socket of sockets) socket.destroy(); srv.close(); });
  const pending = c.request('resources/subscribe', { uri: URI });
  await settle(); assert.equal(started, true);
  await assert.rejects(c.request('resources/subscribe', { uri: URI }), { code: 'RATE_LIMITED' });
  await c.request('resources/unsubscribe', { uri: URI }); finish(); await pending; await settle();
  assert.equal(stopped, 1);
});


test('a message between the history snapshot and subscription is caught up exactly once', async t => {
  const f = await fixture(t), reader = new McpConversationReader(f.c); f.race();
  const conversation = new Conversation(reader, { identity: () => reader.status(), async send() { assert.fail('no write'); } }, () => {});
  await conversation.start(); await conversation.open('2'); await settle();
  assert.deepEqual(conversation.messages.map(m => m.messageId), ['10', '11']);
  const calls = f.reads(); await settle(); assert.equal(f.reads(), calls); conversation.close();
});
