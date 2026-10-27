import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { McpStdioServer } from './mcp-stdio.ts';
import { serveSocket, parseListenSpec, isNonLoopbackHost } from './socket-transport.ts';
import { probe } from './healthcheck.ts';

test('parseListenSpec: port, host:port, tailnet addr, and unix socket paths', () => {
  assert.deepEqual(parseListenSpec('8787'), { host: '127.0.0.1', port: 8787 });
  assert.deepEqual(parseListenSpec('127.0.0.1:8787'), { host: '127.0.0.1', port: 8787 });
  assert.deepEqual(parseListenSpec('100.64.0.1:8787'), { host: '100.64.0.1', port: 8787 });
  assert.deepEqual(parseListenSpec(':9000'), { host: '127.0.0.1', port: 9000 });
  assert.deepEqual(parseListenSpec('/run/kakao-mcp.sock'), { path: '/run/kakao-mcp.sock' });
  assert.deepEqual(parseListenSpec('./x.sock'), { path: './x.sock' });
  assert.throws(() => parseListenSpec('127.0.0.1:nope'), /invalid listen address/);
  assert.throws(() => parseListenSpec('0'), /invalid listen port/);
});

test('isNonLoopbackHost flags only non-loopback binds', () => {
  assert.equal(isNonLoopbackHost('127.0.0.1'), false);
  assert.equal(isNonLoopbackHost('::1'), false);
  assert.equal(isNonLoopbackHost('localhost'), false);
  assert.equal(isNonLoopbackHost('100.64.0.1'), true);
  assert.equal(isNonLoopbackHost('0.0.0.0'), true);
});

/** Spin up a socket-served MCP with a canned get_status, on an ephemeral loopback port. */
function startServer(state: Record<string, unknown>): Promise<{ port: number; close: () => void }> {
  const server = new McpStdioServer({ name: 'test', version: '0.0.1' });
  server.registerTool({
    name: 'get_status',
    description: 'status',
    inputSchema: { type: 'object', properties: {} },
    handler: () => state
  });
  server.registerTool({
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { v: {} } },
    handler: (a) => ({ echoed: a.v })
  });
  const srv = serveSocket(server, { host: '127.0.0.1', port: 0 });
  return new Promise((resolve) => {
    srv.on('listening', () => {
      const addr = srv.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => srv.close() });
    });
  });
}

function rpc(port: number, requests: object[]): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const out: Record<string, any>[] = [];
    sock.on('data', (c) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length === requests.filter((r: any) => r.id != null).length) {
          sock.end();
          resolve(out);
        }
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      for (const r of requests) sock.write(JSON.stringify(r) + '\n');
    });
  });
}

test('socket transport serves JSON-RPC over a real connection', async () => {
  const srv = await startServer({ userId: '42', connected: true, chatCount: 3 });
  try {
    const replies = await rpc(srv.port, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } }
    ]);
    const byId = new Map(replies.map((r) => [r.id, r]));
    assert.equal(byId.get(1)?.result.protocolVersion, '2025-06-18');
    assert.deepEqual(JSON.parse(byId.get(2)?.result.content[0].text), { echoed: 'hi' });
  } finally {
    srv.close();
  }
});

test('a client disconnect does not stop the daemon — a second client still connects', async () => {
  const srv = await startServer({ connected: true });
  try {
    await rpc(srv.port, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]); // first client, then disconnects
    const again = await rpc(srv.port, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.deepEqual(again[0].result, {}); // server still serving
  } finally {
    srv.close();
  }
});

test('healthcheck probe reports healthy when the session is connected', async () => {
  const srv = await startServer({ userId: '42', connected: true, chatCount: 3 });
  try {
    const sock = net.connect(srv.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const result = await probe(sock);
    sock.destroy();
    assert.equal(result.healthy, true);
    assert.equal(result.connected, true);
    assert.equal(result.userId, '42');
    assert.equal(result.chatCount, 3);
  } finally {
    srv.close();
  }
});

test('healthcheck probe reports unhealthy when the LOCO session is down', async () => {
  const srv = await startServer({ userId: '42', connected: false });
  try {
    const sock = net.connect(srv.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const result = await probe(sock);
    sock.destroy();
    assert.equal(result.healthy, false);
    assert.match(result.error!, /not connected/);
  } finally {
    srv.close();
  }
});

test('health diagnostics do not echo invalid status payloads or socket errors', async () => {
  for (const kind of ['payload', 'socket']) {
    const sock = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const result = probe(sock);
    if (kind === 'payload') sock.push(JSON.stringify({ id: 2, result: { content: [{ text: 'fixture-private-status-body' }] } }) + '\n');
    else sock.emit('error', new Error('fixture-private-socket-token'));
    const health = await result; sock.destroy();
    assert.equal(health.healthy, false);
    assert.equal(JSON.stringify(health).includes('fixture-private'), false);
    assert.ok(health.error);
    assert.equal(health.error, kind === 'payload' ? 'bad get_status payload' : 'health connection failed');
  }
});
