import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { reconnectingBridge } from './reconnecting-bridge.ts';
import { openDaemon } from './daemon-connection.ts';
import { diagnoseConnection } from './connection-doctor.ts';

function reader(output: PassThrough) {
  let buffer = ''; const messages: any[] = [], waiters: Array<{ check: (p: any) => boolean; resolve: (p: any) => void }> = [];
  output.on('data', c => { buffer += c.toString(); let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const p = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); messages.push(p);
      for (const waiter of [...waiters]) if (waiter.check(p)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(p); }
    }
  });
  return { messages, wait: (check: (p: any) => boolean) => new Promise<any>((resolve, reject) => {
    const found = messages.find(check); if (found) return resolve(found);
    const timeout = setTimeout(() => reject(new Error('MCP test response timed out')), 3000);
    waiters.push({ check, resolve: p => { clearTimeout(timeout); resolve(p); } });
  }) };
}

test('restart repeats only initialization, reports uncertain writes and drops stale approval answers', { timeout: 10000 }, async t => {
  let connections = 0, operations = 0; const requests: any[] = [], sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    const generation = ++connections; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', c => { buffer += c.toString(); let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const p = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); requests.push({ generation, ...p });
        if (p.method === 'initialize') socket.write(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } } } }) + '\n');
        else if (p.method === 'tools/call' && p.params.name === 'send_message') {
          operations++; socket.write('{"jsonrpc":"2.0","id":77,"method":"elicitation/create","params":{}}\n');
          setImmediate(() => socket.destroy()); // Provider action happened; acknowledgement was lost.
        } else if (p.method === 'tools/call') socket.write(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { connected: true } }) + '\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const input = new PassThrough(), output = new PassThrough(), received = reader(output);
  const done = reconnectingBridge(input, output, () => openDaemon({ listen: `127.0.0.1:${port}` }), { delayMs: 5 });
  t.after(() => { input.end(); for (const socket of sockets) socket.destroy(); server.close(); });
  const send = (p: unknown) => input.write(JSON.stringify(p) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'fixture' } } });
  assert.equal((await received.wait(p => p.id === 1)).result.capabilities.tools.listChanged, true);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { requestId: 'fixture-stable-id', text: '한글 🟡' } } });
  const interrupted = await received.wait(p => p.id === 2);
  assert.equal(interrupted.result.structuredContent.error.retryable, false);
  assert.equal(interrupted.result.structuredContent.error.recovery.action, 'inspect_existing_operation');
  await received.wait(p => p.method === 'notifications/tools/list_changed');
  send({ jsonrpc: '2.0', id: 77, result: { action: 'accept', content: { code: 'ABCD' } } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status' } });
  assert.equal((await received.wait(p => p.id === 3)).result.connected, true);
  assert.equal(operations, 1);
  assert.equal(requests.filter(p => p.method === 'initialize').length, 2);
  assert.deepEqual(requests.filter(p => p.method === 'initialize')[0].params, requests.filter(p => p.method === 'initialize')[1].params);
  assert.ok(!requests.some(p => p.generation > 1 && p.id === 77));
  input.end(); await done;
});

test('initial unavailability buffers initialization, then connects without starting a daemon', { timeout: 10000 }, async t => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', c => { const p = JSON.parse(c.toString()); socket.write(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { ok: true } }) + '\n'); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const input = new PassThrough(), output = new PassThrough(), received = reader(output); let dials = 0;
  t.after(() => { input.end(); for (const s of sockets) s.destroy(); server.close(); });
  const done = reconnectingBridge(input, output, async () => {
    if (++dials < 3) throw new Error('offline fixture');
    return openDaemon({ listen: `127.0.0.1:${(server.address() as net.AddressInfo).port}` });
  }, { delayMs: 5 });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  assert.equal((await received.wait(p => p.id === 1)).result.ok, true); assert.equal(dials, 3);
  input.end(); await done;
});

test('doctor uses only get_status metadata and hides account identifiers', async t => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = ''; socket.on('data', c => { buffer += c.toString(); let n;
      while ((n = buffer.indexOf('\n')) >= 0) { const p = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (p.method === 'tools/call') { assert.equal(p.params.name, 'get_status'); socket.write(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { content: [{ type: 'text', text: JSON.stringify({ connected: true, userId: '123456789' }) }] } }) + '\n'); }
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  const result = await diagnoseConnection({ listen: `127.0.0.1:${(server.address() as net.AddressInfo).port}` });
  assert.equal(result.connected, true); assert.ok(!JSON.stringify(result).includes('123456789'));
});
