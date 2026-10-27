import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { McpStdioServer } from './mcp-stdio.ts';
import { serveSocket } from './socket-transport.ts';
import { allowedUids, uidFromProcNet } from './peer-user.ts';

// /proc/net/tcp rows: client 127.0.0.1:51000 -> daemon 127.0.0.1:18787 as uid 1000, plus the daemon's own row and noise.
const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const TCP = HEAD +
  '   0: 0100007F:4963 00000000:0000 0A 00000000:00000000 00:00000000 00000000   998        0 1 1 0 100 0 0 10 0\n' +
  '   1: 0100007F:C738 0100007F:4963 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1\n' +
  '   2: 0100007F:4963 0100007F:C738 01 00000000:00000000 00:00000000 00000000   998        0 3 1 0 20 4 30 10 -1\n' +
  '   3: 0A000002:C738 0A000009:4963 01 00000000:00000000 00:00000000 00000000  1001        0 4 1 0 20 4 30 10 -1\n';

test('the client end of a loopback connection is found by its exact endpoint', () => {
  assert.equal(uidFromProcNet(TCP, { remoteAddress: '127.0.0.1', remotePort: 51000, localPort: 18787 }), 1000);
  assert.equal(uidFromProcNet(TCP, { remoteAddress: '::ffff:127.0.0.1', remotePort: 51000, localPort: 18787 }), 1000);
  assert.equal(uidFromProcNet(TCP, { remoteAddress: '127.0.0.2', remotePort: 51000, localPort: 18787 }), undefined, 'same ports, other address');
  assert.equal(uidFromProcNet(TCP, { remoteAddress: '127.0.0.1', remotePort: 51001, localPort: 18787 }), undefined);
  const tcp6 = HEAD + '   0: 00000000000000000000000001000000:C738 00000000000000000000000001000000:4963 01 00000000:00000000 00:00000000 00000000  1002 0 5\n';
  assert.equal(uidFromProcNet(tcp6, { remoteAddress: '::1', remotePort: 51000, localPort: 18787 }), 1002);
  assert.deepEqual([...allowedUids([1000, 1000], 998)].sort((a, b) => a - b), [0, 998, 1000]);
});

test('a connection from an OS user that is not allowed is closed before any MCP exchange', async t => {
  const server = new McpStdioServer({ name: 'peer-fixture', version: '0' });
  const logs: string[] = [];
  let uid = 1001;
  const srv = serveSocket(server, { host: '127.0.0.1', port: 0 }, { allowedUids: new Set([0, 998, 1000]), peerUid: () => uid, log: l => logs.push(l) });
  t.after(() => srv.close());
  await new Promise<void>(resolve => srv.once('listening', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  const exchange = () => new Promise<string>(resolve => {
    const c = net.connect(port, '127.0.0.1'); let text = '';
    c.on('data', d => { text += d; if (text.includes('\n')) c.end(); });
    c.on('close', () => resolve(text)); c.on('error', () => resolve(text));
    c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  assert.equal(await exchange(), '', 'refused user gets nothing');
  assert.ok(logs.some(l => l.includes('refused connection from OS user 1001')));
  uid = 1000;
  assert.ok(JSON.parse(await exchange()).result, 'the allowed operator is served');
});
