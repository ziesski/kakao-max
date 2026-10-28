import path from 'node:path';
import net from 'node:net';
import { type UserEndpoint } from '@kakao-max/client';

/** Explicit owner transport. There is no fallback to agent reads when it is unavailable. */
export function userEndpoint(defaultDataDir: string, socketPath?: string, command?: readonly string[]): UserEndpoint {
  if (command && socketPath) throw new Error('Choose an owner socket or an owner bridge command, not both');
  return command ? { command } : { socketPath: socketPath ?? path.join(defaultDataDir, 'user.sock') };
}

/** Used over authenticated SSH under the daemon OS account, with no account settings or tokens in the stream. */
export async function proxyUserConnection(socketPath: string): Promise<void> {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', () => reject(new Error('Owner socket unavailable. Check the daemon version and the OS account running this bridge.')));
  });
  await new Promise<void>(resolve => {
    const done = () => { process.stdin.unpipe(socket); socket.unpipe(process.stdout); socket.destroy(); process.stdin.pause(); resolve(); };
    socket.on('error', done); socket.on('close', done); process.stdin.on('end', done);
    process.stdin.pipe(socket); socket.pipe(process.stdout);
  });
}
