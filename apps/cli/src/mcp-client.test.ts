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

test('only an explicitly configured human form handler negotiates elicitation and supplies its answer', async () => {
  let initialized: any, answer: any;
  const server = net.createServer(sock => {
    let toolId: number;
    readline.createInterface({ input: sock }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') {
        initialized = r.params;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-11-25' } }) + '\n');
      } else if (r.method === 'tools/call') {
        toolId = r.id;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: 'fixture-dialog', method: 'elicitation/create', params: {
          mode: 'form', message: 'fixture approval request', requestedSchema: { properties: { code: { type: 'string' } } }
        } }) + '\n');
      } else if (r.id === 'fixture-dialog') {
        answer = r.result;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: toolId, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const c = new McpClient({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port,
    onElicitation: async params => {
      assert.equal(params.message, 'fixture approval request');
      // Test-only stand-in for a person's typed answer, not extracted from a daemon prompt.
      return { action: 'accept', content: { code: 'TEST', remember: false } };
    } });
  try {
    await c.connect(); assert.deepEqual(await c.callTool('fixture'), { ok: true });
    assert.equal(initialized.protocolVersion, '2025-11-25');
    assert.deepEqual(initialized.capabilities, { elicitation: { form: {} } });
    assert.deepEqual(answer, { action: 'accept', content: { code: 'TEST', remember: false } });
  } finally { c.close(); server.close(); }
});

test('without a human handler an unsolicited elicitation is cancelled, never accepted', async () => {
  let initialized: any, answer: any;
  const server = net.createServer(sock => {
    let toolId: number;
    readline.createInterface({ input: sock }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') {
        initialized = r.params;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\n');
      } else if (r.method === 'tools/call') {
        toolId = r.id;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1234, method: 'elicitation/create', params: { message: 'do not automatically approve' } }) + '\n');
      } else {
        answer = r.result;
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: toolId, result: { content: [{ type: 'text', text: '{}' }] } }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const c = new McpClient({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
  try {
    await c.connect(); await c.callTool('fixture');
    assert.equal(initialized.capabilities, undefined);
    assert.deepEqual(answer, { action: 'cancel' });
  } finally { c.close(); server.close(); }
});

test('a late form answer is not attached to a new request after the original timed out', async () => {
  let finishForm!: (answer: { action: 'accept'; content: { code: string } }) => void;
  let lateAnswers = 0;
  const server = net.createServer(sock => {
    readline.createInterface({ input: sock }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') {
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\n');
      } else if (r.method === 'tools/call' && r.params.name === 'first') {
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: 'late-dialog', method: 'elicitation/create', params: {} }) + '\n');
      } else if (r.method === 'tools/call') {
        finishForm({ action: 'accept', content: { code: 'TEST' } });
        setTimeout(() => sock.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: '{}' }] } }) + '\n'), 20);
      } else if (r.id === 'late-dialog') lateAnswers++;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const c = new McpClient({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, timeoutMs: 100,
    onElicitation: () => new Promise(resolve => { finishForm = resolve; }) });
  try {
    await c.connect(); await assert.rejects(c.callTool('first'), /timed out/);
    await c.callTool('second'); assert.equal(lateAnswers, 0);
  } finally { c.close(); server.close(); }
});
