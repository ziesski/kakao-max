import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { UserReadService, USER_READ_LIMITS, toKakaoError } from '@kakao-max/core';
import { validateListenSpec } from './socket-transport.ts';

/** A distinct OS-owned socket, not an MCP tool or a client-declared role. */
export async function startUserReadServer(service: UserReadService, socketPath: string): Promise<{ close(): void }> {
  if (process.platform === 'win32') throw new Error('Owner read service requires a POSIX daemon; Windows clients can use an SSH bridge');
  socketPath = path.resolve(socketPath);
  validateListenSpec({ path: socketPath }); // Existing directory must be owner-only and owned by this daemon user.
  if (fs.existsSync(socketPath)) {
    const old = fs.lstatSync(socketPath);
    if (!old.isSocket() || old.uid !== process.getuid!()) throw new Error('Unsafe owner read socket');
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = net.connect(socketPath);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Owner read socket probe timed out')); });
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('error', (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED' ? resolve(true) : reject(new Error('Owner read socket unavailable')));
    });
    if (!stale) throw new Error('Owner read socket is already serving');
    const now = fs.lstatSync(socketPath);
    if (now.ino !== old.ino || now.dev !== old.dev) throw new Error('Owner read socket changed during startup');
    fs.unlinkSync(socketPath);
  }
  const clients = new Set<net.Socket>();
  const server = net.createServer(socket => {
    clients.add(socket); let buffer = Buffer.alloc(0), pending = 0;
    socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    const reply = (value: unknown) => {
      let text = JSON.stringify(value);
      if (Buffer.byteLength(text) > USER_READ_LIMITS.responseBytes) text = JSON.stringify({ id: (value as any).id, error: { code: 'RESPONSE_TOO_LARGE', message: 'Narrow the visible message window' } });
      if (socket.writableLength + Buffer.byteLength(text) > USER_READ_LIMITS.responseBytes) { socket.destroy(); return; }
      if (!socket.destroyed) socket.write(text + '\n');
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const newline = buffer.indexOf(10);
        if (newline < 0) { if (buffer.length > USER_READ_LIMITS.requestBytes) socket.destroy(); break; }
        if (newline > USER_READ_LIMITS.requestBytes) { socket.destroy(); break; }
        const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        let request: any;
        try { request = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); break; }
        if (!request || !Number.isSafeInteger(request.id) || request.id < 1 || typeof request.method !== 'string' ||
          Object.keys(request).some(k => !['id', 'method', 'params'].includes(k))) { socket.destroy(); break; }
        if (pending >= 2) { reply({ id: request.id, error: { code: 'BUSY', message: 'Wait for the current read' } }); continue; }
        pending++;
        void service.dispatch(request.method, request.params ?? {}).then(result => reply({ id: request.id, result }), e => {
          const error = toKakaoError(e); reply({ id: request.id, error: { code: error.code, message: error.message } });
        }).finally(() => { pending--; });
      }
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); resolve(); } catch (e) { server.close(); reject(e); }
    });
  });
  const owned = fs.lstatSync(socketPath);
  server.on('error', () => {});
  let closed = false;
  return { close() {
    if (closed) return; closed = true;
    for (const socket of clients) socket.destroy(); server.close();
    try { const current = fs.lstatSync(socketPath); if (current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(socketPath); } catch { /* already removed */ }
  } };
}
