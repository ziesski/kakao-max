import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { UserReadService } from '@kakao-max/core';
import { UserReadClient } from '../../../packages/client/src/user-client.ts';
import { startUserReadServer } from './user-read-server.ts';

const posix = process.platform !== 'win32';
async function fixture(t: any, service?: UserReadService) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ku-')); fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'u');
  const session = {
    getState: () => ({ connected: true, userId: '1' }), listChats: () => [{ id: '2', title: 'fixture unread', unreadCount: 5, lastMessage: 'not metadata' }],
    getUserHistory: async () => ({ messages: [{ messageId: '3', authorId: '1', text: 'fixture owner body' }] }),
    getUserUpdates: () => ({ messages: [], reset: false, removedIds: ['3'] })
  };
  const server = await startUserReadServer(service ?? new UserReadService(session as any), socketPath);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, dir, server };
}

test('owner-only Unix socket provides bounded reads to the shared client and removes itself on close', { skip: !posix }, async t => {
  const f = await fixture(t); const client = new UserReadClient({ socketPath: f.socketPath }); t.after(() => client.close());
  assert.equal(fs.statSync(f.socketPath).mode & 0o777, 0o600);
  await client.connect(); assert.equal((await client.status()).connected, true);
  const rooms = await client.rooms(); assert.equal(rooms[0].unreadCount, 5); assert.ok(!('lastMessage' in rooms[0]));
  assert.equal((await client.history('2')).messages[0].text, 'fixture owner body');
  assert.deepEqual((await client.updates('2', '3', ['3'])).removedIds, ['3']);
  await assert.rejects((client as any).request('send_message', { chatId: '2' }), { code: 'INVALID_ARGUMENT' });
  client.close(); f.server.close(); assert.equal(fs.existsSync(f.socketPath), false);
});

test('owner service rejects public directories, regular files and another live server', { skip: !posix }, async t => {
  const f = await fixture(t);
  await assert.rejects(startUserReadServer({} as any, f.socketPath), /already serving/);
  fs.writeFileSync(path.join(f.dir, 'file'), 'fixture');
  await assert.rejects(startUserReadServer({} as any, path.join(f.dir, 'file')), /Unsafe/);
  fs.chmodSync(f.dir, 0o755);
  await assert.rejects(startUserReadServer({} as any, path.join(f.dir, 'other')));
  fs.chmodSync(f.dir, 0o700);
});

test('oversized or malformed owner frames close before dispatch and never echo supplied text', { skip: !posix }, async t => {
  let calls = 0;
  const f = await fixture(t, { dispatch: async () => { calls++; return {}; } } as any);
  for (const payload of ['x'.repeat(17000), '{private-fixture-invalid-json}\n']) {
    const socket = net.connect(f.socketPath); let output = '';
    socket.on('data', b => { output += b.toString(); }); socket.on('error', () => {});
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.write(payload); await closed;
    assert.equal(output, '');
  }
  assert.equal(calls, 0);
});

test('owner protocol version mismatch fails closed', { skip: !posix }, async t => {
  const f = await fixture(t, { dispatch: async () => ({ version: 999 }) } as any);
  const client = new UserReadClient({ socketPath: f.socketPath }); t.after(() => client.close());
  await assert.rejects(client.connect(), { code: 'VERSION_MISMATCH' });
});

test('SSH-style stdio bridge uses the same private socket and cleans up on client close', { skip: !posix }, async t => {
  const f = await fixture(t);
  const bridgeFile = fileURLToPath(new URL('../../cli/src/user-connection.ts', import.meta.url));
  const source = `import { proxyUserConnection } from ${JSON.stringify(bridgeFile)}; await proxyUserConnection(process.argv[1]);`;
  const client = new UserReadClient({ command: [process.execPath, '--experimental-strip-types', '--input-type=module', '-e', source, f.socketPath] });
  t.after(() => client.close());
  await client.connect(); assert.equal((await client.history('2')).messages.length, 1); client.close();
  await assert.rejects(client.history('2'), { code: 'NOT_CONNECTED' });
});
