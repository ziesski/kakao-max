import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConnection } from '../../mcp/src/daemon-connection.ts';
import { describeEndpoint, isSshTarget, parseWebArgs, sshArgs, sshOpener } from './daemon-endpoint.ts';
import { McpBridge } from './mcp-bridge.ts';

test('without flags the endpoint is MCP_HOST/MCP_PORT as before; --listen overrides it', () => {
  assert.deepEqual(parseWebArgs([], {}), { host: '127.0.0.1', port: 8787 });
  assert.deepEqual(parseWebArgs([], { MCP_HOST: '127.0.0.1', MCP_PORT: '9787' }), { host: '127.0.0.1', port: 9787 });
  assert.deepEqual(parseWebArgs(['--listen', '9000'], { MCP_PORT: '9787' }), { host: '127.0.0.1', port: 9000 });
  assert.deepEqual(parseWebArgs(['--listen', '[::1]:9000'], {}), { host: '::1', port: 9000 });
});

test('--ssh takes a host alias or user@host and reaches the daemon on the server\'s loopback', () => {
  assert.deepEqual(parseWebArgs(['--ssh', 'operator@server'], {}), { host: '127.0.0.1', port: 8787, ssh: 'operator@server' });
  assert.deepEqual(parseWebArgs(['--ssh', 'box', '--listen', '127.0.0.1:9787'], {}), { host: '127.0.0.1', port: 9787, ssh: 'box' });
  assert.equal(describeEndpoint({ host: '127.0.0.1', port: 8787, ssh: 'box' }), '127.0.0.1:8787 on box (via SSH)');
  assert.throws(() => parseWebArgs(['--ssh', 'box', '--listen', '10.0.0.5:8787'], {}), /loopback/);
});

test('flags, options and shell metacharacters are refused as an SSH target', () => {
  for (const bad of ['-oProxyCommand=sh', 'host;rm', 'a b', 'user@', '@host', 'host$(id)', 'host|x', '', 'x'.repeat(254)]) {
    assert.throws(() => parseWebArgs(['--ssh', bad], {}), String(bad));
  }
  for (const bad of [['--ssh'], ['--ssh', 'a', '--ssh', 'b'], ['--open'], ['host'], ['--listen', 'x:y']]) assert.throws(() => parseWebArgs(bad, {}), bad.join(' '));
});

test('the SSH rule matches the MCP connector\'s', () => {
  for (const target of ['box', 'operator@server', 'op_1@host.example', 'host;rm', '-W', 'a@b@c', 'h.', '_x']) {
    let connector = true;
    try { validateConnection({ listen: '127.0.0.1:8787', ssh: target }); } catch { connector = false; }
    assert.equal(isSshTarget(target), connector, target);
  }
});

test('ssh runs stdio forwarding only: no remote command, no prompts, no local port', () => {
  assert.deepEqual(sshArgs({ host: '127.0.0.1', port: 8787, ssh: 'operator@server' }),
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes', '-W', '127.0.0.1:8787', '--', 'operator@server']);
  assert.equal(sshArgs({ host: '::1', port: 9, ssh: 'box' }).at(-3), '[::1]:9');
});

test('the bridge speaks MCP through the ssh stdio stream and reconnects when ssh exits', { skip: process.platform === 'win32' }, async (t) => {
  // A stand-in for ssh: records its arguments, answers initialize and one tool call, then exits on request.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-max-web-ssh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'argv.log'), fake = path.join(dir, 'fake-ssh');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');
  if (m.method === 'tools/call' && m.params.name === 'get_status') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"connected":true}' }] } }) + '\\n');
  if (m.method === 'tools/call' && m.params.name === 'exit') process.exit(255);
});
`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  const endpoint = { host: '127.0.0.1', port: 8787, ssh: 'operator@server' };
  const bridge = new McpBridge({ open: sshOpener(endpoint, fake), reconnectDelayMs: 50 });
  bridge.on('error', () => {});
  t.after(() => bridge.close());
  await bridge.connect();
  assert.deepEqual(await bridge.getStatus(), { connected: true });
  const reconnected = new Promise((r) => bridge.once('connected', r));
  await bridge.callTool('exit').catch(() => undefined);
  await reconnected;
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, 'ssh was started again after it exited');
  assert.deepEqual(calls[0], sshArgs(endpoint));
});

test('the GUI refuses an unsafe --ssh before it starts', () => {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--experimental-strip-types', entry, '--ssh', '-oProxyCommand=touch'], { env: { ...process.env, PORT: '0' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /Usage: kakao-max-web/); assert.doesNotMatch(r.stdout, /launch\?t=/);
});
