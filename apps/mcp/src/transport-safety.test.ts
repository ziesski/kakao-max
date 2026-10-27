import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { McpStdioServer, MCP_LIMITS } from './mcp-stdio.ts';
import { LocoError } from '@kakao-max/protocol';
import { serveSocket, parseListenSpec, isNonLoopbackHost, validateListenSpec } from './socket-transport.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function connection(server: McpStdioServer, onClose?: () => void) {
  const input = new PassThrough(); let data = '';
  const output = new Writable({ write(chunk, _encoding, done) { data += chunk.toString(); done(); } });
  server.serveConnection(input, output, onClose);
  return { input, output, replies: () => data.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const request = (id: number, name = 'hold') => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }) + '\n';

test('unauthenticated MCP TCP rejects external and unspecified binds before creating a listener', t => {
  let attempts = 0;
  t.mock.method(net, 'createServer', () => { attempts++; throw new Error('listener should not be constructed'); });
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  for (const host of [undefined, '', '0.0.0.0', '::', '100.64.0.1', '192.0.2.1', 'example.com']) {
    assert.equal(isNonLoopbackHost(host), true);
    assert.throws(() => serveSocket(server, { host, port: 8787 }), { code: 'CONFIG_INVALID' });
  }
  assert.equal(attempts, 0);
});

test('listen parser bounds ports and supports explicit bracketed IPv6 loopback', () => {
  assert.deepEqual(parseListenSpec('[::1]:8787'), { host: '::1', port: 8787 });
  for (const value of ['65536', '127.0.0.1:65536', '-1', '1.5', '127.0.0.1:NaN']) assert.throws(() => parseListenSpec(value));
});

test('oversized fragmented requests without a newline close before any tool executes', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' }); let calls = 0;
  server.registerTool({ name: 'hold', description: 'fixture', inputSchema: { type: 'object' }, handler: () => { calls++; } });
  const c = connection(server);
  c.input.write(Buffer.alloc(MCP_LIMITS.frameBytes, 65));
  c.input.write('B');
  await tick();
  assert.equal(c.input.destroyed, true); assert.equal(calls, 0);
  assert.match(c.replies()[0].error.message, /byte limit/);
});

test('UTF-8 records survive split multibyte chunks and EOF without a newline', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  server.registerTool({ name: 'echo', description: 'fixture', inputSchema: { type: 'object' }, handler: a => a });
  let closed = 0; const c = connection(server, () => closed++);
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: '가나다' } } }));
  const split = bytes.indexOf(Buffer.from('가')) + 1;
  c.input.write(bytes.subarray(0, split)); c.input.end(bytes.subarray(split));
  await tick();
  assert.deepEqual(JSON.parse(c.replies()[0].result.content[0].text), { text: '가나다' });
  assert.equal(closed, 1);
});

test('malformed MCP requests never place their contents in routine diagnostics', async t => {
  let logs = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { logs += chunk.toString(); return true; });
  const c = connection(new McpStdioServer({ name: 'fixture', version: '1' }));
  c.input.end('{fixture-private-secret-message\n'); await tick();
  assert.equal(c.replies()[0].error.code, -32700);
  assert.match(logs, /invalid MCP JSON/); assert.equal(logs.includes('fixture-private'), false);
});

test('malformed provider and unexpected internal errors stay private across the MCP wire', async () => {
  for (const error of [new LocoError('MALFORMED', 'fixture-private-provider-token', { command: 'GETTRAILER' }),
    new Error('fixture-private-account-body')]) {
    const server = new McpStdioServer({ name: 'fixture', version: '1' });
    server.registerTool({ name: 'hold', description: 'fixture', inputSchema: { type: 'object' }, handler: () => { throw error; } });
    const c = connection(server); c.input.end(request(1)); await tick();
    const response = c.replies()[0];
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error.code, 'INTERNAL');
    assert.equal(JSON.stringify(response).includes('fixture-private'), false);
    if (error instanceof LocoError) assert.equal(response.result.structuredContent.error.details.command, 'GETTRAILER');
  }
});

test('concurrency is bounded across clients and EOF waits for active work rather than dropping it', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' }); let calls = 0, closeCount = 0;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  server.registerTool({ name: 'hold', description: 'fixture', inputSchema: { type: 'object' }, handler: async () => { calls++; await barrier; return { ok: true }; } });
  const a = connection(server, () => closeCount++), b = connection(server);
  a.input.end(Array.from({ length: MCP_LIMITS.concurrentTools }, (_, id) => request(id)).join(''));
  b.input.write(request(100)); await tick();
  assert.equal(calls, MCP_LIMITS.concurrentTools); assert.equal(closeCount, 0);
  assert.equal(b.replies()[0].result.structuredContent.error.code, 'RATE_LIMITED');
  release(); await tick();
  assert.equal(closeCount, 1); assert.equal(a.replies().length, MCP_LIMITS.concurrentTools);
  b.input.end(request(101)); await tick();
  assert.equal(calls, MCP_LIMITS.concurrentTools + 1);
  assert.equal(b.replies().at(-1).result.isError, false);
});

test('oversized tool responses return an explicit error without partial private content', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  server.registerTool({ name: 'hold', description: 'fixture', inputSchema: { type: 'object' }, handler: () => ({ text: 'fixture-private-' + 'x'.repeat(MCP_LIMITS.responseBytes) }) });
  const c = connection(server); c.input.end(request(1)); await tick();
  const response = c.replies()[0];
  assert.equal(response.id, 1); assert.match(response.error.message, /Response exceeds/);
  assert.equal(JSON.stringify(response).includes('fixture-private'), false);
});


test('a slow consumer cannot grow the response backlog without bound', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  server.registerTool({ name: 'hold', description: 'fixture', inputSchema: { type: 'object' }, handler: () => 'x'.repeat(MCP_LIMITS.responseBytes / 2) });
  const input = new PassThrough(); let writes = 0;
  const output = new Writable({ highWaterMark: 1, write() { writes++; /* deliberately no drain */ } });
  server.serveConnection(input, output);
  input.write(request(1) + request(2)); await tick();
  assert.equal(input.destroyed, true); assert.equal(writes, 1);
  assert.ok(output.writableLength <= MCP_LIMITS.responseBytes);
  output.destroy();
});


test('Unix sockets require an owned private directory and refuse permissionless abstract paths', { skip: process.platform === 'win32' && 'Unix sockets' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = path.join(root, 'fixture.sock');
  fs.chmodSync(root, 0o700); assert.doesNotThrow(() => validateListenSpec({ path: socket }));
  fs.chmodSync(root, 0o755); assert.throws(() => validateListenSpec({ path: socket }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateListenSpec({ path: '@abstract' }), { code: 'CONFIG_INVALID' });
  const link = root + '-link'; fs.symlinkSync(root, link); t.after(() => fs.unlinkSync(link));
  assert.throws(() => validateListenSpec({ path: path.join(link, 'fixture.sock') }), { code: 'CONFIG_INVALID' });
});


test('bounded media envelopes preserve existing base64 tools while oversized ordinary calls remain rejected', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' }); let calls = 0;
  server.registerTool({ name: 'send_photo_bundle', maxRequestBytes: MCP_LIMITS.frameBytes, description: 'fixture', inputSchema: { type: 'object' }, handler: () => { calls++; return { ok: true }; } });
  const media = connection(server);
  media.input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_photo_bundle', arguments: { photos: ['x'.repeat(100000)] } } }) + '\n');
  await tick(); assert.equal(calls, 1); assert.equal(media.replies()[0].result.isError, false);
  const ordinary = connection(server);
  ordinary.input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { padding: 'x'.repeat(100000) } }) + '\n');
  await tick(); assert.equal(ordinary.input.destroyed, true); assert.match(ordinary.replies()[0].error.message, /byte limit/);
});

test('large-envelope tools have one shared slot while ordinary tools remain available', async () => {
  const server = new McpStdioServer({ name: 'fixture', version: '1' });
  let release!: () => void, calls = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  server.registerTool({ name: 'hold', maxRequestBytes: MCP_LIMITS.frameBytes, description: 'fixture', inputSchema: { type: 'object' }, handler: async () => { calls++; await barrier; return {}; } });
  const a = connection(server), b = connection(server);
  a.input.write(request(1)); b.input.write(request(2)); await tick();
  assert.equal(calls, 1); assert.equal(b.replies()[0].result.structuredContent.error.code, 'RATE_LIMITED');
  b.input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n'); await tick();
  assert.deepEqual(b.replies().at(-1).result, {});
  release(); await tick(); a.input.end(); b.input.end();
});

test('Windows refuses Unix socket paths and keeps loopback TCP', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  assert.throws(() => validateListenSpec({ path: path.join(os.tmpdir(), 'fixture.sock') }), { code: 'CONFIG_INVALID' });
  assert.doesNotThrow(() => validateListenSpec(parseListenSpec('127.0.0.1:8787')));
});
