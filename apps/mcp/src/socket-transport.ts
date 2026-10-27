// ----------------------------------------------------------------------------
// Socket transport for the MCP server — the always-on daemon face.
//
// The stdio transport serves exactly one client (the process that spawned us) and
// exits when its stdin closes. For an always-on deployment we instead want a long-lived process that holds the warm LOCO session and
// lets a client — the personal-agent runtime, or an MCP client over SSH —
// connect, drive tools, disconnect, and reconnect, all without tearing down the
// KakaoTalk session.
//
// This is the SAME newline-delimited JSON-RPC framing as stdio (each TCP/Unix-socket
// connection is just another line-oriented duplex), so no new protocol surface — we
// reuse McpStdioServer.serveConnection per connection. A client disconnect drops only
// that connection; the daemon (and the LOCO session) stays up.
//
// TCP is loopback-only: this raw protocol has no remote authentication. Use
// stdio or an authenticated SSH tunnel. On Linux a TCP connection is served only
// for allowed OS users (peer-user.ts). Unix sockets require a private parent
// directory. Zero runtime deps (node:net); strip-types safe.
// ----------------------------------------------------------------------------

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { KakaoError, toKakaoError } from '@kakao-max/core';
import type { McpStdioServer } from './mcp-stdio.ts';
import { peerUid } from './peer-user.ts';

export interface ListenSpec {
  /** A Unix socket path, or undefined for TCP. */
  path?: string;
  /** TCP host (ignored when `path` is set). */
  host?: string;
  /** TCP port (ignored when `path` is set). */
  port?: number;
}

/**
 * Parse a listen spec string:
 *   "8787"            -> TCP 127.0.0.1:8787
 *   "127.0.0.1:8787"  -> TCP 127.0.0.1:8787
 *   "[::1]:8787"     -> TCP on IPv6 loopback
 *   "/private-owner-directory/kakao.sock" or "./x.sock" -> Unix socket
 * Parsing is also used by clients; serveSocket validates safe server binding.
 */
export function parseListenSpec(raw: string, defaultHost = '127.0.0.1'): ListenSpec {
  const v = raw.trim();
  if (v.includes('/') || v.startsWith('.') || v.startsWith('@')) return { path: v };
  const colon = v.lastIndexOf(':');
  if (colon === -1) {
    const port = Number(v);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid listen port: ${raw}`);
    return { host: defaultHost, port };
  }
  const rawHost = v.slice(0, colon) || defaultHost;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const port = Number(v.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid listen address: ${raw}`);
  return { host, port };
}

/** Unspecified hosts bind all interfaces and must also be refused. */
export function isNonLoopbackHost(host: string | undefined): boolean {
  return host !== '127.0.0.1' && host !== '::1' && host !== 'localhost';
}

/** This raw TCP transport has no remote authentication; use an SSH tunnel. */
export function validateListenSpec(spec: ListenSpec): void {
  if (spec.path !== undefined) {
    // Owner-only socket files cannot be enforced through Windows ACLs here; loopback TCP is the Windows transport.
    if (process.platform === 'win32') throw new KakaoError('CONFIG_INVALID', 'MCP Unix sockets are not supported on Windows; listen on 127.0.0.1:PORT');
    if (!spec.path || spec.path.startsWith('@') || spec.path.includes('\0') || spec.host !== undefined || spec.port !== undefined) throw new KakaoError('CONFIG_INVALID', 'Invalid MCP Unix socket specification');
    try {
      const parent = fs.lstatSync(path.dirname(path.resolve(spec.path)));
      if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || !process.getuid || parent.uid !== process.getuid()) throw new Error('Unsafe parent');
    } catch { throw new KakaoError('CONFIG_INVALID', 'MCP Unix socket requires an existing owner-only directory'); }
    return;
  }
  if (isNonLoopbackHost(spec.host)) throw new KakaoError('CONFIG_INVALID', 'MCP TCP requires loopback; use stdio or an authenticated SSH tunnel');
  if (!Number.isInteger(spec.port) || spec.port! < 0 || spec.port! > 65535) throw new KakaoError('CONFIG_INVALID', 'Invalid MCP TCP port');
}

/**
 * Start a socket server that serves `server` on every accepted connection. Returns the
 * net.Server (call `.close()` to stop accepting). `onConnection` is a hook for logging.
 */
export function serveSocket(
  server: McpStdioServer,
  spec: ListenSpec,
  opts: {
    log?: (line: string) => void; onConnection?: () => void;
    /** TCP only: serve a connection only when its OS user is in this set (see peer-user.ts); undefined = no check. */
    allowedUids?: ReadonlySet<number>; peerUid?: (socket: net.Socket) => number | undefined;
  } = {}
): net.Server {
  validateListenSpec(spec);
  const log = opts.log ?? (() => {});
  const srv = net.createServer((socket) => {
    if (!spec.path && opts.allowedUids) {
      const uid = (opts.peerUid ?? peerUid)(socket);
      if (uid === undefined || !opts.allowedUids.has(uid)) {
        // Close before reading a byte: an unknown local user gets no tool list, no dialog and no account state.
        log(`refused connection from OS user ${uid ?? 'unknown'}; allow it with KAKAO_MCP_ALLOWED_UIDS`);
        socket.destroy();
        return;
      }
    }
    socket.setNoDelay(true);
    opts.onConnection?.();
    // Each connection is its own duplex; serveConnection writes replies back to it.
    server.serveConnection(socket, socket);
    socket.on('error', (e) => log(`connection error: ${toKakaoError(e).code}`));
  });
  srv.maxConnections = 16;
  srv.on('error', (e) => log(`socket server error: ${toKakaoError(e).code}`));
  if (spec.path) {
    srv.listen(spec.path, () => {
      try { fs.chmodSync(spec.path!, 0o600); log(`listening on unix:${spec.path}`); }
      catch { log('Unix socket permissions failed; closing listener'); srv.close(); }
    });
  } else {
    srv.listen(spec.port!, spec.host === 'localhost' ? '127.0.0.1' : spec.host, () => log(`listening on tcp://${spec.host}:${spec.port}`));
  }
  return srv;
}
