import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('CLI smoke diagnostics omit account, room, friend and message data on success and failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sockets = new Set<net.Socket>(), calls: string[] = [];
  let failFriends = false;
  const chat = { id: '987654321', title: 'fixture-private-room', type: 'DirectChat', unreadCount: 0, lastSendAt: 1 };
  const messages = [1, 2].map(n => ({ chatId: chat.id, authorId: '111111111', messageId: String(100 + n),
    text: 'fixture-private-message', sendAt: n }));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    // Windows resets the connection when the CLI child exits; readline re-emits that on the interface.
    readline.createInterface({ input: socket }).on('error', () => {}).on('line', line => {
      const req = JSON.parse(line);
      let result: unknown = { protocolVersion: '2025-06-18' };
      if (req.method === 'tools/call') {
        const { name, arguments: args } = req.params; calls.push(name);
        let data: unknown;
        if (name === 'get_status') data = { connected: true, userId: '123456789' };
        else if (name === 'list_chats') data = args.chatId ? { access: { rule: { mode: 'immediate' } } } : { chats: [chat] };
        else if (name === 'list_friends') data = { count: 1, friends: [{ userId: '111111111', nickName: 'fixture-private-friend' }] };
        else if (name === 'read_messages') data = args.mode === 'search'
          ? { count: args.query === 'fixture-private-message' ? 1 : 0, messages: [] }
          : { untrusted: true, messages };
        else throw new Error('Unexpected smoke tool');
        result = name === 'list_friends' && failFriends
          ? { isError: true, content: [{ type: 'text', text: 'fixture-private-provider-error' }],
            structuredContent: { error: { code: 'NETWORK', message: 'fixture-private-provider-error' } } }
          : { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KAKAO_')));
  env.MCP_HOST = '127.0.0.1'; env.MCP_PORT = String((server.address() as net.AddressInfo).port);
  for (const fails of [false, true]) {
    failFriends = fails;
    const result = await new Promise<{ code: number; output: string }>(resolve => {
      execFile(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url)), 'test'],
        { cwd: root, env, timeout: 15000 }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, output: stdout + stderr }));
    });
    assert.equal(result.code, fails ? 1 : 0, result.output);
    assert.match(result.output, fails ? /FAIL/ : /통과/);
    for (const privateValue of ['123456789', chat.id, '111111111', 'fixture-private']) {
      assert.equal(result.output.includes(privateValue), false, 'smoke diagnostics must not disclose fixture data');
    }
  }
  assert.ok(calls.every(name => ['get_status', 'list_chats', 'list_friends', 'read_messages'].includes(name)));
});
