// Connect only to an existing daemon; no account login or remote shell command.
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { KakaoError } from '@kakao-max/core';
import { parseListenSpec, validateListenSpec } from './socket-transport.ts';

export interface ConnectionOptions { listen: string; ssh?: string }
export function validateConnection(opts: ConnectionOptions): void {
  const spec = parseListenSpec(opts.listen); validateListenSpec(spec);
  if (opts.ssh && (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(opts.ssh) || opts.ssh.length > 253 || spec.path)) {
    throw new KakaoError('INVALID_ARGUMENT', 'Use an SSH host alias or user@host and a loopback TCP endpoint');
  }
  if (spec.path) {
    const stat = fs.lstatSync(spec.path);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new KakaoError('CONFIG_INVALID', 'Expected an owner-only daemon socket');
  }
}
export function openDaemon(opts: ConnectionOptions): Promise<Duplex> {
  validateConnection(opts);
  const spec = parseListenSpec(opts.listen);
  if (opts.ssh) {
    const address = spec.host === '::1' ? `[::1]:${spec.port}` : `127.0.0.1:${spec.port}`;
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes', '-W', address, '--', opts.ssh], { stdio: ['pipe', 'pipe', 'pipe'] });
    // SSH diagnostic text may contain account/host details. Do not forward it into MCP.
    child.stderr.resume();
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.on('error', () => stream.destroy(new Error('SSH connection unavailable')));
    child.on('exit', code => { if (code) stream.destroy(new Error('SSH connection closed')); });
    stream.once('close', () => { child.stdin.end(); child.kill(); });
    return Promise.resolve(stream);
  }
  return new Promise((resolve, reject) => {
    const socket = spec.path ? net.connect(spec.path) : net.connect(spec.port!, spec.host);
    socket.setTimeout(5000);
    socket.once('timeout', () => socket.destroy(new Error('Daemon connection timed out')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.setTimeout(0); socket.removeListener('error', reject); resolve(socket); });
  });
}
