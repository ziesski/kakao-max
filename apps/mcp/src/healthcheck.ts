#!/usr/bin/env node
// ----------------------------------------------------------------------------
// Liveness probe for the always-on MCP daemon.
//
// systemd's Restart=always keeps the process up, but a running process is not the
// same as a HEALTHY one — the LOCO session can be disconnected while the process
// lingers. This probe connects over the socket, drives the real MCP handshake
// (initialize → tools/call get_status), and exits 0 only when the session reports
// `connected: true`. Wire it to a systemd timer, a cron heartbeat, or Uptime Kuma.
//
//   KAKAO_MCP_LISTEN=127.0.0.1:8787 node --experimental-strip-types src/healthcheck.ts
//   npm run health --workspace=@kakao-max/mcp
//
// Exit codes: 0 healthy, 1 unhealthy/unreachable. Never prints tokens. Zero deps.
// ----------------------------------------------------------------------------

import net from 'node:net';
import { parseListenSpec } from './socket-transport.ts';

import { loadConfig, isMainModule } from '@kakao-max/core';

export interface HealthResult {
  healthy: boolean;
  connected?: boolean;
  userId?: string;
  chatCount?: number;
  error?: string;
}

/**
 * Run the probe against an already-open duplex (a TCP/Unix socket). Resolves with a
 * structured result; never rejects. Exposed separately from the socket dial so tests can
 * drive it against an in-process server connection.
 */
export function probe(sock: NodeJS.ReadWriteStream, timeoutMs = 5000): Promise<HealthResult> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (r: HealthResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ healthy: false, error: 'timeout waiting for get_status' }), timeoutMs);

    const send = (obj: unknown) => sock.write(JSON.stringify(obj) + '\n');
    sock.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          // tools/call get_status reply
          if (msg.result?.isError) return finish({ healthy: false, error: 'get_status returned isError' });
          try {
            const state = JSON.parse(msg.result?.content?.[0]?.text ?? '{}');
            return finish({
              healthy: state.connected === true,
              connected: state.connected === true,
              userId: state.userId != null ? String(state.userId) : undefined,
              chatCount: typeof state.chatCount === 'number' ? state.chatCount : undefined,
              error: state.connected === true ? undefined : 'LOCO session not connected'
            });
          } catch {
            return finish({ healthy: false, error: 'bad get_status payload' });
          }
        }
      }
    });
    sock.on('error', () => finish({ healthy: false, error: 'health connection failed' }));
    sock.on('close', () => finish({ healthy: false, error: 'connection closed before get_status reply' }));

    // Drive the handshake, then ask for status.
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const listen = process.argv[2] || config.mcpListen;
  if (!listen) {
    process.stderr.write('[health] set KAKAO_MCP_LISTEN (or pass an address arg), e.g. 127.0.0.1:8787\n');
    process.exit(1);
  }
  const spec = parseListenSpec(listen.trim());
  const sock = spec.path ? net.connect(spec.path) : net.connect(spec.port!, spec.host);
  sock.setNoDelay(true);

  const result = await new Promise<HealthResult>((resolve) => {
    sock.once('connect', () => probe(sock, config.healthTimeoutMs).then(resolve));
    sock.once('error', () => resolve({ healthy: false, error: 'health connection failed' }));
  });
  sock.destroy();

  if (result.healthy) {
    process.stderr.write(`[health] OK — connected (chats=${result.chatCount ?? '?'})\n`);
    process.exit(0);
  }
  process.stderr.write(`[health] UNHEALTHY — ${result.error ?? 'unknown'}\n`);
  process.exit(1);
}

if (isMainModule(import.meta.url, 'healthcheck')) {
  main().catch(() => {
    process.stderr.write('[health] fatal: health probe failed\n');
    process.exit(1);
  });
}
