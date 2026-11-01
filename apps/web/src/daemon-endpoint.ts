import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

// ----------------------------------------------------------------------------
// Where the GUI finds the daemon. Locally: a TCP endpoint (MCP_HOST/MCP_PORT, or
// --listen). With --ssh <host>: the same stdio forwarding the MCP connector uses
// (`ssh -W 127.0.0.1:<port>`), so no remote shell runs, no local port is opened
// for the tunnel, and the daemon stays on the server's loopback.
// ----------------------------------------------------------------------------

export interface DaemonEndpoint {
  host: string;
  port: number;
  /** SSH host alias or user@host; the daemon is then reached on that server's loopback. */
  ssh?: string;
}

export const WEB_USAGE = 'Usage: kakao-max-web [--ssh <host-alias|user@host>] [--listen <[host:]port>]';

/** Same rule as setup's --ssh: a host alias or user@host, no flags or shell metacharacters. */
const SSH_TARGET = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export function isSshTarget(value: string): boolean {
  return SSH_TARGET.test(value) && value.length <= 253;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function parsePort(raw: string, what: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid ${what}: ${raw}`);
  return port;
}

/** "8787", "127.0.0.1:8787" or "[::1]:8787". */
function parseListen(raw: string): { host: string; port: number } {
  const colon = raw.lastIndexOf(':');
  if (colon === -1) return { host: '127.0.0.1', port: parsePort(raw, '--listen port') };
  let host = raw.slice(0, colon) || '127.0.0.1';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port: parsePort(raw.slice(colon + 1), '--listen port') };
}

/**
 * Command-line flags win over MCP_HOST/MCP_PORT. Without --ssh the endpoint behaves as before.
 * With --ssh the endpoint is on the server and must be its loopback (the daemon listens nowhere else).
 */
export function parseWebArgs(argv: string[], env: Record<string, string | undefined>): DaemonEndpoint {
  let ssh: string | undefined, listen: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    if ((flag !== '--ssh' && flag !== '--listen') || value === undefined || value.startsWith('-')) throw new Error(WEB_USAGE);
    if (flag === '--ssh') {
      if (ssh !== undefined) throw new Error(WEB_USAGE);
      ssh = value;
    } else {
      if (listen !== undefined) throw new Error(WEB_USAGE);
      listen = value;
    }
    i++;
  }
  if (ssh !== undefined && !isSshTarget(ssh)) throw new Error('Use an SSH host alias or user@host, without flags or shell commands');
  const endpoint = listen !== undefined ? parseListen(listen) : { host: env.MCP_HOST || '127.0.0.1', port: env.MCP_PORT ? parsePort(env.MCP_PORT, 'MCP_PORT') : 8787 };
  if (ssh !== undefined && !LOOPBACK.has(endpoint.host)) throw new Error('With --ssh the daemon endpoint is on the server\'s loopback (127.0.0.1 or ::1)');
  return { ...endpoint, ...(ssh !== undefined ? { ssh } : {}) };
}

/** Human-readable endpoint for the terminal (never contains secrets). */
export function describeEndpoint(e: DaemonEndpoint): string {
  const address = e.host.includes(':') ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`;
  return e.ssh ? `${address} on ${e.ssh} (via SSH)` : address;
}

/** The ssh arguments: stdio forwarding only, never a remote command; BatchMode so it never waits on a prompt. */
export function sshArgs(e: DaemonEndpoint & { ssh: string }): string[] {
  const address = e.host === '::1' ? `[::1]:${e.port}` : `127.0.0.1:${e.port}`;
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes', '-W', address, '--', e.ssh];
}

/** Opens one daemon connection through `ssh -W`. The stream closes when ssh exits. */
export function sshOpener(e: DaemonEndpoint & { ssh: string }, command = 'ssh'): () => Duplex {
  const args = sshArgs(e);
  return () => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // SSH diagnostics can name hosts and accounts; keep them off the page and out of the MCP stream.
    child.stderr.resume();
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const end = (message: string) => { if (!stream.destroyed) stream.destroy(new Error(message)); };
    child.on('error', () => end('SSH could not be started'));
    child.on('exit', (code) => end(code ? `SSH connection closed (exit ${code}); check that \`ssh ${e.ssh}\` works without a prompt` : 'SSH connection closed'));
    stream.once('close', () => { child.stdin.end(); child.kill(); });
    return stream;
  };
}
