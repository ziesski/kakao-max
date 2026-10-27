import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bridgeMcp, connectorArgs } from './connect.ts';

test('connector passes UTF-8, MRTR state and large payloads unchanged, including the final reply after stdin EOF', { skip: process.platform === 'win32' && 'Unix sockets' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-'));
  const socketPath = path.join(root, 'daemon.sock');
  const request = Buffer.from(JSON.stringify({ method: 'tools/call', params: { text: '한글🟡', requestState: 'sealed-state',
    inputResponses: { approve: { content: { code: 'ABCD' } } }, bytes: 'x'.repeat(200000) } }) + '\n');
  let connections = 0;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    connections++; const chunks: Buffer[] = [];
    socket.on('data', c => chunks.push(c));
    socket.on('end', () => { assert.deepEqual(Buffer.concat(chunks), request); socket.end(Buffer.from('{"result":"확인됨"}\n')); });
  });
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  server.listen(socketPath); await once(server, 'listening'); fs.chmodSync(socketPath, 0o600);
  const input = new PassThrough(), chunks: Buffer[] = [];
  const output = new Writable({ highWaterMark: 8, write(chunk, _encoding, cb) { chunks.push(Buffer.from(chunk)); setImmediate(cb); } });
  const done = bridgeMcp(input, output, socketPath);
  input.write(request.subarray(0, 17)); input.end(request.subarray(17)); await done;
  assert.equal(Buffer.concat(chunks).toString(), '{"result":"확인됨"}\n'); assert.equal(connections, 1);
  output.end();
});

test('connector refusal is nonzero and does not start a daemon or replay anything', async t => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  await assert.rejects(bridgeMcp(input, output, `127.0.0.1:${port}`), { code: 'NETWORK', retryable: false });
  const script = fileURLToPath(new URL('./connect.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--listen', `127.0.0.1:${port}`], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /No login or replay/);
});

test('connector rejects public endpoints, bad arguments and non-private Unix sockets', { skip: process.platform === 'win32' && 'Unix sockets' }, async t => {
  assert.equal(connectorArgs(['--listen','127.0.0.1:8787']), '127.0.0.1:8787');
  assert.throws(() => connectorArgs([]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => bridgeMcp(new PassThrough(), new PassThrough(), '0.0.0.0:8787'), { code: 'CONFIG_INVALID' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsafe-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'not-a-socket'); fs.writeFileSync(file, 'fixture');
  assert.throws(() => bridgeMcp(new PassThrough(), new PassThrough(), file), { code: 'CONFIG_INVALID' });
  assert.throws(() => bridgeMcp(new PassThrough(), new PassThrough(), path.join(root, 'missing.sock')), { code: 'NETWORK' });
  const server = net.createServer(), socket = path.join(root, 'wide.sock');
  server.listen(socket); await once(server, 'listening'); fs.chmodSync(socket, 0o666);
  assert.throws(() => bridgeMcp(new PassThrough(), new PassThrough(), socket), { code: 'CONFIG_INVALID' });
  await new Promise<void>(resolve => server.close(() => resolve()));
});
