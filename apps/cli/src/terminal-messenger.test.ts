import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { TerminalMessenger, terminalWidth } from './terminal-messenger.ts';
import { McpToolError } from './mcp-client.ts';
import type { ConversationReader, MessageWriter } from '@kakao-max/client';

function fixture(demo = true) {
  const calls: { name: string; args: Record<string, any> }[] = [];
  let events: any[] = [], receiveError: Error | undefined, sendError: Error | undefined;
  const reader: ConversationReader = {
    async status() { calls.push({ name: 'status', args: {} }); return { connected: true, userId: '1', mode: 'ask' }; },
    async rooms() { calls.push({ name: 'rooms', args: {} }); return [
      { id: '101', title: 'PRIVATE NAME', unreadCount: 4 },
      { id: '202', title: '공개 테스트방', unreadCount: 3 }
    ]; },
    async history(chatId) {
      calls.push({ name: 'history', args: { chatId } });
      return { messages: [{ messageId: '20', authorId: '2', authorName: 'PRIVATE AUTHOR', text: 'fixture history', sendAt: 1000 }], hasMore: false };
    },
    async updates(chatId, after, visibleIds) {
      calls.push({ name: 'updates', args: { chatId, after, visibleIds } });
      if (receiveError) throw receiveError;
      return { messages: events.filter(e => BigInt(e.messageId) > BigInt(after)), reset: false, removedIds: [] };
    }
  };
  const writer: MessageWriter = { async identity() { return { connected: true, userId: '1' }; }, async send(chatId, text, requestId) {
    calls.push({ name: 'send_message', args: { chatId, text, requestId } });
    if (sendError) throw sendError;
    return { ok: true, messageId: '40' };
  } };
  const view = new TerminalMessenger(reader, writer, demo ? { demo, showRoom: '공개 테스트방' } : {}, () => {});
  return { view, reader, calls, setEvents: (e: any[]) => { events = e; },
    receiveError: (e?: Error) => { receiveError = e; }, sendError: (e: Error) => { sendError = e; } };
}
async function open(f: ReturnType<typeof fixture>) {
  await f.view.start(); await f.view.key('공개 테스트방'); await f.view.key('', { name: 'return' });
  assert.equal(f.view.focus, 'chat');
}
const display = (v: TerminalMessenger) => stripVTControlCharacters(v.render(110, 24));

test('searchable room picker hides private labels and blocks opening private rooms', async () => {
  const f = fixture(); await f.view.start();
  assert.ok(!display(f.view).includes('PRIVATE NAME'));
  await f.view.key('', { name: 'return' });
  assert.equal(f.calls.filter(c => c.name === 'history').length, 0);
  await f.view.key('공개'); await f.view.key('', { name: 'return' });
  assert.equal(f.view.conversation.active?.title, '공개 테스트방');
  assert.deepEqual(f.calls.find(c => c.name === 'history')?.args, { chatId: '202' });
  assert.ok(display(f.view).includes('fixture history'));
  assert.ok(!display(f.view).includes('PRIVATE AUTHOR'));
});

test('receiving selected-room messages preserves input, aliases authors and deduplicates feed history', async () => {
  const f = fixture(); await open(f); await f.view.key('작성 중인 문장');
  f.setEvents([
    { seq: 1, messageId: '20', authorId: '2', text: 'fixture history', sendAt: 1000 },
    { seq: 2, messageId: '30', authorId: '2', authorName: 'PRIVATE AUTHOR', text: 'fixture incoming', sendAt: 1001 }
  ]);
  await f.view.poll(); await f.view.poll();
  assert.equal(f.view.draft.text, '작성 중인 문장');
  assert.equal(display(f.view).match(/fixture incoming/g)?.length, 1);
  assert.equal(display(f.view).match(/fixture history/g)?.length, 1);
  assert.ok(!display(f.view).includes('PRIVATE AUTHOR'));
  const reads = f.calls.filter(c => c.name === 'updates');
  assert.deepEqual(reads.map(c => c.args.after), ['20', '30']);
  assert.ok(reads.every(c => c.args.chatId === '202'));
  assert.equal(f.calls.filter(c => c.name === 'mark_read').length, 0);
});

test('typing a command-like sentence in chat sends literal text once and shows local acknowledgement', async () => {
  const f = fixture(); await open(f);
  await f.view.key('ls -al'); await f.view.key('', { name: 'return' });
  const sends = f.calls.filter(c => c.name === 'send_message');
  assert.equal(sends.length, 1); assert.equal(sends[0].args.text, 'ls -al'); assert.equal(sends[0].args.chatId, '202');
  assert.equal(f.view.draft.text, '');
  assert.ok(display(f.view).includes('ls -al'));
  f.setEvents([{ seq: 1, messageId: '40', authorId: '1', text: 'ls -al', sendAt: Date.now() / 1000 }]);
  await f.view.poll();
  assert.equal(display(f.view).match(/ls -al/g)?.length, 1);
});

test('pasted newlines never submit a message; Enter afterward explicitly sends', async () => {
  const f = fixture(); await open(f);
  await f.view.key('', { name: 'paste-start' }); await f.view.key('line one');
  await f.view.key('\r', { name: 'return' }); await f.view.key('line two'); await f.view.key('', { name: 'paste-end' });
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 0);
  assert.equal(f.view.draft.text, 'line one line two');
  await f.view.key('', { name: 'return' });
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 1);
});

test('unknown outcomes retain draft and block a second send', async () => {
  const f = fixture(); await open(f); f.sendError(new Error('fixture timeout'));
  await f.view.key('fixture message'); await f.view.key('', { name: 'return' }); await f.view.key('', { name: 'return' });
  assert.equal(f.view.draft.text, 'fixture message');
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 1);
});

test('polling failure stops repeated reads and exposes no private error details in demo mode', async () => {
  const f = fixture(); await open(f); f.receiveError(new McpToolError('read_messages', 'secret-account-value', 'POLICY_DENIED'));
  await f.view.poll(); const count = f.calls.length; await f.view.poll();
  assert.equal(f.calls.length, count); assert.equal(f.view.polling, false);
  assert.ok(!display(f.view).includes('secret-account-value'));
  f.receiveError(); await f.view.key('', { ctrl: true, name: 'r' });
  assert.equal(f.view.polling, true);
});

test('grapheme-aware editing keeps Korean and emoji intact; resize and clipping respect terminal cells', async () => {
  const f = fixture(); await open(f); await f.view.key('한글👩‍💻');
  await f.view.key('', { name: 'backspace' }); assert.equal(f.view.draft.text, '한글');
  await f.view.key('', { name: 'left' }); await f.view.key('A'); assert.equal(f.view.draft.text, '한A글');
  for (const columns of [72, 90, 140]) {
    const rows = stripVTControlCharacters(f.view.render(columns, 24)).split(/\r?\n/);
    assert.ok(rows.every(row => terminalWidth(row) <= columns - 1)); assert.ok(rows.length <= 24);
  }
  assert.ok(stripVTControlCharacters(f.view.render(40, 10)).includes('넓혀'));
});

test('normal-mode approval uses only human input, defaults remember off, and closes safely', async () => {
  const f = fixture(false); await f.view.start();
  const form = { message: 'fixture approval request', requestedSchema: { properties: { code: { type: 'string' }, remember: { title: '계속 허용' } } } };
  const answer = f.view.askApproval(form);
  await f.view.key('T'); await f.view.key('E'); await f.view.key('S'); await f.view.key('T');
  await f.view.key('', { name: 'return' }); await f.view.key('', { name: 'return' });
  assert.deepEqual(await answer, { action: 'accept', content: { code: 'TEST', remember: false } });
  const cancelled = f.view.askApproval(form); f.view.close(); assert.deepEqual(await cancelled, { action: 'cancel' });
});

test('demo mode never exposes an approval form', async () => {
  const f = fixture(); await f.view.start();
  assert.deepEqual(await f.view.askApproval({ message: 'secret-account-value' }), { action: 'cancel' });
  assert.ok(!display(f.view).includes('secret-account-value'));
});

test('human room opening and updates do not request an agent read grant or require unread zero', async () => {
  const f = fixture(false); await open(f); await f.view.poll();
  assert.ok(f.calls.some(c => c.name === 'history'));
  assert.ok(f.calls.some(c => c.name === 'updates'));
  assert.ok(!f.calls.some(c => ['request_permission', 'mark_read', 'read_messages'].includes(c.name)));
  assert.equal(f.view.polling, true);
});


test('one-time read approval pauses polling instead of repeatedly asking', async () => {
  const f = fixture(false);
  await f.view.start();
  const history = f.reader.history.bind(f.reader);
  f.reader.history = async chatId => {
    await f.view.askApproval({ mode: 'form', requestedSchema: { properties: { code: { type: 'string' }, remember: { type: 'boolean', title: '앞으로 읽기' } } } });
    return history(chatId);
  };
  await f.view.key('공개 테스트방');
  const opening = f.view.key('', { name: 'return' });
  await f.view.key('fixture-code'); await f.view.key('', { name: 'return' });
  await f.view.key('', { name: 'return' }); await opening;
  assert.equal(f.view.focus, 'chat'); assert.equal(f.view.polling, false);
  await f.view.poll(); assert.equal(f.calls.filter(c => c.name === 'updates').length, 0);
  assert.ok(display(f.view).includes('모드: ask'));
});

test('unread policy errors explain the shared ask restriction', async () => {
  const f = fixture(); await open(f);
  f.receiveError(new McpToolError('read_messages', 'fixture', 'ROOM_NOT_READ'));
  await f.view.poll();
  assert.equal(f.view.polling, false);
  for (const [columns, rows] of [[72, 14], [80, 24], [110, 30]]) {
    const screen = stripVTControlCharacters(f.view.render(columns, rows));
    assert.ok(screen.includes('ask 모드'));
    assert.ok(screen.includes('trust 모드'));
    assert.ok(screen.split(/\r?\n/).length <= rows);
    assert.ok(screen.split(/\r?\n/).every(row => terminalWidth(row) <= columns - 1));
  }
});

test('Ctrl+R retries the room whose initial open failed after its read state changes', async () => {
  const f = fixture();
  const history = f.reader.history;
  let unread = true;
  f.reader.history = async (...args) => {
    if (unread) throw new McpToolError('read_messages', 'fixture unread', 'ROOM_NOT_READ');
    return history(...args);
  };
  await f.view.start();
  await f.view.key('공개 테스트방');
  await f.view.key('', { name: 'return' });
  assert.equal(f.view.conversation.active, undefined);
  assert.equal(f.view.polling, false);
  unread = false;
  await f.view.key('', { ctrl: true, name: 'r' });
  assert.deepEqual(f.view.conversation.active, f.view.conversation.rooms.find(room => room.id === '202'));
  assert.equal(f.view.polling, true);
  assert.ok(display(f.view).includes('fixture history'));
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 0);
});


test('unknown read-state errors explain missing sync rather than claiming the person has not read', async () => {
  const f = fixture(); await open(f);
  f.receiveError(new McpToolError('read_messages', 'private provider detail', 'ROOM_NOT_READ', false, { reason: 'unread_unknown' }));
  await f.view.poll();
  const screen = display(f.view);
  assert.ok(screen.includes('서버의 읽음 상태를 확인할 수 없습니다.'));
  assert.ok(screen.includes('trust 모드'));
  assert.ok(!screen.includes('안읽은 방은'));
  assert.ok(!screen.includes('private provider detail'));
});


test('read-limit failure followed by send keeps old messages and the paused-refresh warning', async () => {
  const f = fixture(); await open(f);
  f.receiveError(new McpToolError('read_messages', 'private budget detail', 'RATE_LIMITED'));
  await f.view.poll();
  assert.ok(display(f.view).includes('fixture history'));
  assert.ok(display(f.view).includes('한도'));
  const afterFailure = f.calls.length; await f.view.poll();
  assert.equal(f.calls.length, afterFailure);
  await f.view.key('fixture reply'); await f.view.key('', { name: 'return' });
  const screen = display(f.view);
  assert.ok(screen.includes('fixture history'));
  assert.ok(screen.includes('fixture reply'));
  assert.ok(screen.includes('전송 요청 처리 완료'));
  assert.ok(screen.includes('자동 갱신 중지'));
  assert.ok(!screen.includes('private budget detail'));
  assert.equal(f.view.polling, false);
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 1);
});

test('reconnection refreshes a live view but never resumes an explicitly stopped read', async () => {
  const f = fixture(); await open(f);
  f.view.connectionLost(Object.assign(new Error('fixture disconnected'), { code: 'NOT_CONNECTED' }));
  await f.view.reconnected(); assert.equal(f.view.polling, true);
  f.view.polling = false; f.view.conversation.stopUpdates();
  const before = f.calls.filter(c => c.name === 'history').length;
  f.view.connectionLost(Object.assign(new Error('fixture disconnected'), { code: 'NOT_CONNECTED' }));
  await f.view.reconnected();
  assert.equal(f.view.polling, false); assert.equal(f.calls.filter(c => c.name === 'history').length, before);
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 0);
});

test('a disconnected account remains unready until metadata reports its recovery', async () => {
  const f = fixture(); await open(f);
  const original = f.reader.status;
  f.reader.status = async () => ({ connected: false, userId: '1' });
  f.view.connectionLost(Object.assign(new Error('fixture account reconnect'), { code: 'NOT_CONNECTED' }));
  await f.view.reconnected(); assert.equal(f.view.conversation.connected, false); assert.equal(f.view.polling, false);
  f.reader.status = original; await f.view.reconnected();
  assert.equal(f.view.conversation.connected, true); assert.equal(f.view.polling, true);
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 0);
});
