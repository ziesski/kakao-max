#!/usr/bin/env node
// Opaque MCP bridge to the existing daemon. Never imports KakaoSession or loads credentials.
import net from 'node:net';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { KakaoError, isMainModule, setupCommand } from '@kakao-max/core';
import { reconnectingBridge } from './reconnecting-bridge.ts';
import { openDaemon, validateConnection, type ConnectionOptions } from './daemon-connection.ts';
import { parseListenSpec, validateListenSpec } from './socket-transport.ts';

export function bridgeMcp(input: Readable, output: Writable, listen: string, timeoutMs = 5000): Promise<void> {
  let spec;
  try { spec = parseListenSpec(listen); }
  catch (cause) { throw new KakaoError('CONFIG_INVALID', 'Invalid MCP daemon endpoint', { cause }); }
  validateListenSpec(spec);
  if (spec.path) {
    let s;
    try { s = fs.lstatSync(spec.path); }
    catch (cause) { throw new KakaoError('NETWORK', 'Existing MCP Unix socket is unavailable; no daemon was started', { cause, retryable: false }); }
    if (!s.isSocket() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) {
      throw new KakaoError('CONFIG_INVALID', 'MCP Unix socket must be owned by this user with no group/other access');
    }
  }
  return new Promise((resolve, reject) => {
    const socket = spec.path ? net.createConnection(spec.path)
      : net.createConnection({ host: spec.host === 'localhost' ? '127.0.0.1' : spec.host, port: spec.port! });
    let failure: KakaoError | undefined;
    const fail = () => {
      failure ??= new KakaoError('NETWORK', 'Cannot reach the existing MCP daemon; no account session was started', { retryable: false });
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, fail);
    socket.once('connect', () => {
      socket.setTimeout(0); // Long-polls and human approval dialogs are not connection timeouts.
      input.pipe(socket); socket.pipe(output, { end: false });
    });
    input.once('error', fail); output.once('error', fail); socket.once('error', fail);
    socket.once('close', () => {
      input.unpipe(socket); input.pause(); socket.unpipe(output);
      input.removeListener('error', fail); output.removeListener('error', fail);
      if (failure) reject(failure); else resolve();
    });
  });
}

export function connectorArgs(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--listen' || !args[1]) {
    throw new KakaoError('INVALID_ARGUMENT', 'Usage: connect.ts --listen <loopback-address-or-private-unix-socket>');
  }
  return args[1];
}

export function resilientConnectorArgs(args: string[]): ConnectionOptions {
  const options: ConnectionOptions = { listen: '' };
  if (args.filter(a => a === '--resilient').length !== 1) throw new KakaoError('INVALID_ARGUMENT', 'Expected --resilient once');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resilient') continue;
    const key = args[i] === '--listen' ? 'listen' : args[i] === '--ssh' ? 'ssh' : undefined;
    if (!key || !args[i + 1] || options[key]) throw new KakaoError('INVALID_ARGUMENT', 'Use --resilient --listen <endpoint> [--ssh user@host]');
    options[key] = args[++i];
  }
  if (!options.listen) throw new KakaoError('INVALID_ARGUMENT', 'A daemon endpoint is required');
  validateConnection(options); return options;
}

if (isMainModule(import.meta.url, 'connect')) {
  Promise.resolve().then(() => {
    const args = process.argv.slice(2);
    if (!args.includes('--resilient')) return bridgeMcp(process.stdin, process.stdout, connectorArgs(args));
    const options = resilientConnectorArgs(args);
    return reconnectingBridge(process.stdin, process.stdout, () => openDaemon(options));
  })
    .catch(() => { process.stderr.write(`[connect] Existing MCP daemon unavailable or unsafe endpoint. No login or replay was attempted. Run ${setupCommand('--doctor')} with the same connection settings.\n`); process.exitCode = 1; });
}
