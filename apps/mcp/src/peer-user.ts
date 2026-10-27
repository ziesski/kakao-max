// Which OS user opened a loopback TCP connection to the daemon (Linux /proc/net/tcp{,6}).
//
// Loopback keeps the network out, but not other users and services on the same host. MCP itself has no
// authentication, and the client confirmation dialog trusts the client to show it to a person: a local
// process that connects can read the code and answer the dialog itself. So the daemon accepts a TCP
// connection only from allowed OS users. An `ssh -W` tunnel arrives as the SSH login user, so client
// settings do not change. Unix sockets are limited by their private directory instead.
import fs from 'node:fs';
import type net from 'node:net';

/** Kernel hex form of an IPv4 address in /proc/net/tcp: "0100007F" for 127.0.0.1. */
function ipv4Hex(address: string): string | undefined {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  if (!v4) return undefined;
  return v4.slice(1).reverse().map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const LOOPBACK6 = new Set(['00000000000000000000000001000000', '0000000000000000FFFF00000100007F']);

/**
 * The uid owning the client end of this connection, from /proc/net/tcp text: the row whose local
 * endpoint is the peer's and whose remote endpoint is ours. Undefined when no row matches.
 */
export function uidFromProcNet(text: string, conn: { remoteAddress: string; remotePort: number; localPort: number }): number | undefined {
  const port = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  const peer4 = ipv4Hex(conn.remoteAddress);
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [localAddr, localPort] = cols[1].split(':'), [, remotePort] = cols[2].split(':');
    if (localPort !== port(conn.remotePort) || remotePort !== port(conn.localPort)) continue;
    // The peer is on this host, so its address is loopback; for IPv4 it must also be the exact peer address.
    if (localAddr.length === 8 ? localAddr !== peer4 : !LOOPBACK6.has(localAddr.toUpperCase())) continue;
    const uid = Number(cols[7]);
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  }
  return undefined;
}

export function peerUid(socket: net.Socket, read: (file: string) => string = file => fs.readFileSync(file, 'utf8')): number | undefined {
  if (!socket.remoteAddress || !socket.remotePort || !socket.localPort) return undefined;
  const conn = { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, localPort: socket.localPort };
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = read(file); } catch { continue; }
    const uid = uidFromProcNet(text, conn);
    if (uid !== undefined) return uid;
  }
  return undefined;
}

/** The daemon's own user and root are always allowed; `extra` comes from KAKAO_MCP_ALLOWED_UIDS. */
export function allowedUids(extra: readonly number[], self: number): Set<number> {
  return new Set([self, 0, ...extra]);
}
