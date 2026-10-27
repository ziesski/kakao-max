import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import readline from 'node:readline';
import { McpBridge } from './mcp-bridge.ts';

/** A fake MCP daemon on a random local port: counts connections and answers `initialize` unless told not to. */
async function fakeDaemon(opts: { answerInit?: boolean } = {}) {
  const sockets: net.Socket[] = [];
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    sockets.push(s);
    s.on('error', () => {});
    readline.createInterface({ input: s }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize' && opts.answerInit !== false) {
        s.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    get connections() {
      return connections;
    },
    dropAll: () => sockets.splice(0).forEach((s) => s.destroy()),
    stop: () => new Promise<void>((r) => server.close(() => r()))
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bridgeFor(port: number, opts: { reconnectDelayMs?: number; initTimeoutMs?: number } = {}) {
  const bridge = new McpBridge({ host: '127.0.0.1', port, reconnectDelayMs: 50, ...opts });
  bridge.on('error', () => {}); // an EventEmitter 'error' without a listener would throw
  return bridge;
}

test('concurrent connect() calls share one socket', async (t) => {
  const d = await fakeDaemon();
  const bridge = bridgeFor(d.port);
  t.after(async () => {
    bridge.close();
    await d.stop();
  });
  await Promise.all([bridge.connect(), bridge.connect(), bridge.connect()]);
  assert.equal(bridge.isConnected, true);
  assert.equal(d.connections, 1);
});

test('a dropped connection reconnects exactly once, and close() stops reconnecting', async (t) => {
  const d = await fakeDaemon();
  const bridge = bridgeFor(d.port);
  t.after(() => d.stop());
  await bridge.connect();
  const reconnected = new Promise((r) => bridge.once('connected', r));
  d.dropAll();
  await reconnected;
  await sleep(200); // several reconnect intervals: no extra attempts while connected
  assert.equal(d.connections, 2);

  bridge.close();
  d.dropAll();
  await sleep(200);
  assert.equal(d.connections, 2);
  await assert.rejects(bridge.connect(), /closed/);
});

test('a daemon that never answers initialize fails the connect after initTimeoutMs', async (t) => {
  const d = await fakeDaemon({ answerInit: false });
  const bridge = bridgeFor(d.port, { initTimeoutMs: 100, reconnectDelayMs: 10_000 });
  t.after(async () => {
    bridge.close();
    await d.stop();
  });
  const started = Date.now();
  await assert.rejects(bridge.connect(), /timed out|disconnected/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(bridge.isConnected, false);
});
