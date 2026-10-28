import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { TerminalMessenger, terminalWidth } from './terminal-messenger.ts';
import { McpToolError } from './mcp-client.ts';
import type { ShellClient } from './chat-shell.ts';

function fixture(demo = true) {
  const calls: { name: string; args: Record<string, any> }[] = [];
  let events: any[] = [], receiveError: Error | undefined, sendError: Error | undefined;
  const client: ShellClient = { async callTool(name, args = {}) {
    calls.push({ name, args });
    if (name === 'get_status') return { connected: true, userId: '1' } as any;
    if (name === 'list_chats') return { chats: [
      { id: '101', title: 'PRIVATE NAME', unreadCount: 4 },
      { id: '202', title: '공개 테스트방', unreadCount: 0 }
    ] } as any;
    if (name === 'read_messages') {
      if (args.mode === 'recent') {
        if (receiveError) throw receiveError;
        return { messages: events.filter(e => e.seq > Number(args.sinceSeq)), cursor: events.at(-1)?.seq ?? args.sinceSeq } as any;
      }
      return { messages: [{ messageId: '20', authorId: '2', authorName: 'PRIVATE AUTHOR', text: 'fixture history', sendAt: 1000 }] } as any;
    }
    if (name === 'send_message') {
      if (sendError) throw sendError;
      return { status: 0, state: 'sent_unverified', requestId: args.requestId, logId: '40' } as any;
    }
    throw new Error('unexpected tool');
  } };
  const view = new TerminalMessenger(client, demo ? { demo, showRoom: '공개 테스트방' } : {}, () => {});
  return { view, calls, setEvents: (e: any[]) => { events = e; },
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
  assert.equal(f.calls.filter(c => c.name === 'read_messages').length, 0);
  await f.view.key('공개'); await f.view.key('', { name: 'return' });
  assert.equal(f.view.shell.currentTitle, '공개 테스트방');
  assert.deepEqual(f.calls.find(c => c.name === 'read_messages')?.args, { chatId: '202', limit: 30 });
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
  const reads = f.calls.filter(c => c.name === 'read_messages' && c.args.mode === 'recent');
  assert.deepEqual(reads.map(c => c.args.sinceSeq), [0, 2]);
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

test('one-time read approval does not turn into repeated background approval prompts', async () => {
  let view: TerminalMessenger, reads = 0;
  const client: ShellClient = { async callTool(name) {
    if (name === 'get_status') return { connected: true } as any;
    if (name === 'list_chats') return { chats: [{ id: '101', title: 'fixture room' }] } as any;
    reads++;
    await view.askApproval({ message: 'fixture one-time read', requestedSchema: { properties: {
      code: { type: 'string' }, remember: { title: '이 방은 앞으로 묻지 않고 읽기' }
    } } });
    return { messages: [] } as any;
  } };
  view = new TerminalMessenger(client, {}, () => {});
  await view.start();
  const opening = view.key('', { name: 'return' });
  await new Promise<void>(resolve => setImmediate(resolve));
  await view.key('TEST'); await view.key('', { name: 'return' }); await view.key('', { name: 'return' });
  await opening; assert.equal(view.polling, false);
  await view.poll(); assert.equal(reads, 1);
});
