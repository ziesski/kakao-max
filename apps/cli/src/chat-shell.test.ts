import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatShell, shellText, type ShellClient } from './chat-shell.ts';
import { McpToolError } from './mcp-client.ts';

function fixture(options: { demo?: boolean; showRoom?: string } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let rooms = [
    { id: '101', title: 'Private fixture', memberCount: 3, unreadCount: 2 },
    { id: '202', title: 'Public fixture', memberCount: 2, unreadCount: 0 }
  ];
  let readError: Error | undefined, sendError: Error | undefined;
  const client: ShellClient = { async callTool(name, args = {}) {
    calls.push({ name, args });
    if (name === 'get_status') return { connected: true, userId: '11' } as any;
    if (name === 'list_chats') return { chats: rooms.map(r => ({ ...r, lastMessage: 'PRIVATE PREVIEW' })) } as any;
    if (name === 'read_messages') {
      if (readError) throw readError;
      return { messages: args.beforeLogId ? [
        { messageId: '19', authorId: '22', authorName: 'Secret author', text: 'older fixture', sendAt: 900 }
      ] : [
        { messageId: '22', authorId: '11', text: 'newer fixture', sendAt: 1002 },
        { messageId: '20', authorId: '22', authorName: 'Secret author', text: 'cd Private fixture\x1b[2J', sendAt: 1000 },
        { messageId: '21', authorId: '22', text: 'middle fixture', sendAt: 1001 },
        { messageId: '23', authorId: '22', text: '{"feedType":4,"members":[{"userId":987654321,"nickName":"HIDDEN FEED NAME"}]}', sendAt: 1003 }
      ] } as any;
    }
    if (name === 'send_message') {
      if (sendError) throw sendError;
      return { status: 0, state: 'sent_unverified', logId: '33', requestId: args.requestId } as any;
    }
    if (name === 'get_operation') return { state: 'sent_unverified' } as any;
    throw new Error('Unexpected tool ' + name);
  } };
  return { shell: new ChatShell(client, line => lines.push(line), options), lines, calls,
    setRooms: (value: typeof rooms) => { rooms = value; },
    setReadError: (value?: Error) => { readError = value; },
    setSendError: (value?: Error) => { sendError = value; } };
}

test('demo masks names in listing/completion and prevents reading hidden rooms', async () => {
  const f = fixture({ demo: true, showRoom: 'Public fixture' });
  await f.shell.start();
  await f.shell.execute('ls -al');
  const [completed] = f.shell.complete('cd ');
  assert.deepEqual(completed, ['cd Public fixture']);
  assert.ok(!f.lines.join('\n').includes('Private fixture'));
  assert.ok(!f.lines.join('\n').includes('PRIVATE PREVIEW'));
  assert.ok(f.lines.some(s => s.includes('대화방 001')));
  for (const query of ['cd 대화방 001', 'cd 1', 'cd Private fixture', 'cd 101']) await f.shell.execute(query);
  assert.equal(f.calls.filter(c => c.name === 'read_messages').length, 0);
  assert.equal(f.shell.prompt, 'kakao:/ > ');
});

test('entering room reads 30 chronologically without a receipt, aliases authors and keeps input separate', async () => {
  const f = fixture({ demo: true, showRoom: 'Public fixture' });
  await f.shell.start();
  await f.shell.execute('cd Public fixture');
  const read = f.calls.find(c => c.name === 'read_messages');
  assert.deepEqual(read?.args, { chatId: '202', limit: 30 });
  assert.ok(f.shell.prompt.includes('Public fixture'));
  const output = f.lines.join('\n');
  assert.ok(output.indexOf('cd Private fixture') < output.indexOf('middle fixture'));
  assert.ok(output.indexOf('middle fixture') < output.indexOf('newer fixture'));
  assert.ok(!output.includes('Secret author'));
  assert.ok(!output.includes('HIDDEN FEED NAME'));
  assert.ok(!output.includes('987654321'));
  assert.ok(output.includes('(대화방 알림)'));
  assert.ok(!output.includes('\x1b'));
  assert.equal(f.calls.filter(c => c.name === 'send_message' || c.name === 'mark_read').length, 0);
});

test('send input preserves literal text and gets a distinct caller-chosen UUID per successful operation', async () => {
  const f = fixture(); await f.shell.start(); await f.shell.execute('cd Public fixture');
  await f.shell.execute('hello fixture'); await f.shell.execute('/send cd Private fixture');
  const sends = f.calls.filter(c => c.name === 'send_message');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].args.text, 'hello fixture');
  assert.equal(sends[1].args.text, 'cd Private fixture');
  assert.equal(sends[0].args.chatId, '202');
  assert.match(String(sends[0].args.requestId), /^[0-9a-f-]{36}$/);
  assert.notEqual(sends[0].args.requestId, sends[1].args.requestId);
  assert.ok(!f.lines.join('\n').includes('logId'));
});

test('failed cd clears old recipient; failed read does not select new room', async () => {
  const f = fixture(); await f.shell.start(); await f.shell.execute('cd Public fixture');
  await f.shell.execute('cd missing'); await f.shell.execute('do not send');
  assert.equal(f.shell.prompt, 'kakao:/ > ');
  f.setReadError(new McpToolError('read_messages', 'fixture denied', 'POLICY_DENIED'));
  await f.shell.execute('cd Private fixture'); await f.shell.execute('also do not send');
  assert.equal(f.shell.prompt, 'kakao:/ > ');
  assert.equal(f.calls.filter(c => c.name === 'send_message').length, 0);
});

test('ambiguous room labels never choose first; numeric listing selection works', async () => {
  const f = fixture(); f.setRooms([{ id: '101', title: 'same', memberCount: 1, unreadCount: 0 }, { id: '202', title: 'same', memberCount: 1, unreadCount: 0 }]);
  await f.shell.start(); await f.shell.execute('cd same');
  assert.equal(f.calls.filter(c => c.name === 'read_messages').length, 0);
  await f.shell.execute('cd 2');
  assert.equal(f.calls.find(c => c.name === 'read_messages')?.args.chatId, '202');
});

test('unknown sends and approval-required sends block another typed send; pending only queries same operation', async () => {
  for (const error of [new Error('timeout'), new McpToolError('send_message', 'approve first', 'APPROVAL_REQUIRED')]) {
    const f = fixture(); await f.shell.start(); await f.shell.execute('cd Public fixture');
    f.setSendError(error); await f.shell.execute('fixture payload'); await f.shell.execute('fixture payload');
    assert.equal(f.calls.filter(c => c.name === 'send_message').length, 1);
    const id = f.calls.find(c => c.name === 'send_message')!.args.requestId;
    await f.shell.execute('/pending');
    assert.equal(f.calls.find(c => c.name === 'get_operation')?.args.requestId, id);
    assert.equal(f.calls.filter(c => c.name === 'send_message').length, 1);
  }
});

test('demo errors cannot expose account IDs or grant URLs through server error text', async () => {
  const f = fixture({ demo: true, showRoom: 'Public fixture' }); await f.shell.start();
  f.setReadError(new McpToolError('read_messages', 'account=private-value url=https://example.invalid/token', 'POLICY_DENIED'));
  await f.shell.execute('cd Public fixture');
  assert.ok(f.lines.some(s => s.includes('POLICY_DENIED')));
  assert.ok(!f.lines.join('\n').includes('private-value'));
  assert.ok(!f.lines.join('\n').includes('example.invalid'));
});

test('demo public room cannot transfer to a replacement room with same title', async () => {
  const f = fixture({ demo: true, showRoom: 'Public fixture' }); await f.shell.start();
  f.setRooms([{ id: '303', title: 'Public fixture', memberCount: 2, unreadCount: 0 }]);
  await f.shell.execute('cd Public fixture');
  assert.equal(f.shell.prompt, 'kakao:/ > ');
  assert.equal(f.calls.filter(c => c.name === 'read_messages').length, 0);
});

test('history is bounded and older uses exclusive lower ID bound with no read receipts', async () => {
  const f = fixture(); await f.shell.start(); await f.shell.execute('cd Public fixture');
  await f.shell.execute('history 101');
  assert.equal(f.calls.filter(c => c.name === 'read_messages').length, 1);
  await f.shell.execute('older');
  assert.deepEqual(f.calls.filter(c => c.name === 'read_messages')[1].args, { chatId: '202', limit: 30, beforeLogId: '19' });
  assert.equal(f.calls.filter(c => c.name === 'mark_read').length, 0);
  await f.shell.execute('cd ..');
  assert.equal(f.shell.prompt, 'kakao:/ > ');
});

test('titles/messages cannot inject terminal controls, new prompt lines or bidi controls', () => {
  const result = shellText('fixture\x1b]0;fake title\x07\x1b[2J\nforged\rprompt\u202e');
  assert.ok(!/[\x00-\x1f\x7f\u202e]/.test(result));
  assert.ok(result.includes('forged'));
});

test('demo rejects missing/ambiguous public room at startup', async () => {
  assert.throws(() => fixture({ demo: true }));
  const f = fixture({ demo: true, showRoom: 'missing' });
  await assert.rejects(f.shell.start(), /公開|공개/);
});
