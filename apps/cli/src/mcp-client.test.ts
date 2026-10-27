import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import readline from 'node:readline';
import { McpClient, McpToolError } from './mcp-client.ts';

// A fake daemon: answers initialize, and tools/call by tool name.
function fakeDaemon(handle: (name: string, args: any) => any): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      readline.createInterface({ input: sock }).on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }) + '\n');
          return;
        }
        const out = handle(req.params.name, req.params.arguments);
        if (out === undefined) return; // simulate a hung tool
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: out }) + '\n');
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => srv.close() });
    });
  });
}

test('callTool parses JSON text results', async () => {
  const d = await fakeDaemon((name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }], isError: false }));
  const c = new McpClient({ host: '127.0.0.1', port: d.port });
  try {
    await c.connect();
    assert.deepEqual(await c.callTool('list_chats', { filter: 'direct' }), { name: 'list_chats', args: { filter: 'direct' } });
  } finally {
    c.close();
    d.close();
  }
});

test('callTool throws McpToolError on isError results', async () => {
  const d = await fakeDaemon(() => ({
    content: [{ type: 'text', text: 'Error [POLICY_DENIED]: send denied [message-as-you]: not allowlisted' }],
    structuredContent: { error: { code: 'POLICY_DENIED', message: 'send denied [message-as-you]: not allowlisted', retryable: false } },
    isError: true
  }));
  const c = new McpClient({ host: '127.0.0.1', port: d.port });
  try {
    await c.connect();
    await assert.rejects(c.callTool('send_message', {}), (e: unknown) => {
      assert.ok(e instanceof McpToolError);
      assert.equal(e.tool, 'send_message');
      assert.equal(e.message, 'send denied [message-as-you]: not allowlisted');
      assert.equal(e.code, 'POLICY_DENIED');
      assert.equal(e.retryable, false);
      return true;
    });
  } finally {
    c.close();
    d.close();
  }
});

test('request times out instead of hanging', async () => {
  const d = await fakeDaemon(() => undefined);
  const c = new McpClient({ host: '127.0.0.1', port: d.port, timeoutMs: 100 });
  try {
    await c.connect();
    await assert.rejects(c.callTool('get_status'), /timed out/);
  } finally {
    c.close();
    d.close();
  }
});

test('connect rejects when no daemon is listening', async () => {
  const d = await fakeDaemon(() => undefined);
  d.close();
  const c = new McpClient({ host: '127.0.0.1', port: d.port });
  await assert.rejects(c.connect());
});
