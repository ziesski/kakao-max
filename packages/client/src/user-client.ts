import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { USER_READ_LIMITS, USER_READ_VERSION } from '@kakao-max/core/user-read';
import type { UserReader, UserRoom, UserHistory, UserUpdates } from '@kakao-max/core';

export interface UserEndpoint { socketPath?: string; command?: readonly string[]; }
export class UserReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
/** Shared by first-party frontends. The OS socket/SSH process, not a role flag, authenticates it. */
export class UserReadClient implements UserReader {
  private readonly endpoint: UserEndpoint;
  private input?: Readable;
  private output?: Writable;
  private socket?: net.Socket;
  private child?: ChildProcess;
  private buffer = Buffer.alloc(0);
  private id = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(endpoint: UserEndpoint) {
    if (!!endpoint.socketPath === !!endpoint.command) throw new UserReadError('CONFIG_INVALID', 'Choose an owner socket or an explicit SSH command');
    if (endpoint.command && (!endpoint.command.length || endpoint.command.length > 64 || endpoint.command.some(v => typeof v !== 'string' || !v || /[\0\r\n]/.test(v)))) throw new UserReadError('CONFIG_INVALID', 'Invalid owner bridge command');
    this.endpoint = endpoint;
  }
  async connect(): Promise<void> {
    if (this.closed || this.input) throw new UserReadError('NOT_CONNECTED', 'Create a new owner connection');
    if (this.endpoint.socketPath) {
      const socket = net.connect(this.endpoint.socketPath); this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve); socket.once('error', () => reject(new UserReadError('USER_API_UNAVAILABLE', 'Owner read service unavailable; update the daemon or check the owner connection')));
      });
      this.input = socket; this.output = socket;
    } else {
      const command = this.endpoint.command!;
      this.child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      this.input = this.child.stdout!; this.output = this.child.stdin!;
      this.child.on('error', () => this.fail(new UserReadError('USER_API_UNAVAILABLE', 'Owner SSH bridge could not start')));
      this.child.on('exit', () => this.fail(new UserReadError('USER_API_UNAVAILABLE', 'Owner SSH bridge ended; check the daemon version and OS account permissions')));
    }
    this.input.on('data', chunk => this.onData(Buffer.from(chunk)));
    this.input.on('error', () => this.fail(new UserReadError('NOT_CONNECTED', 'Owner read connection failed')));
    this.input.on('end', () => this.fail(new UserReadError('NOT_CONNECTED', 'Owner read connection closed')));
    this.output.on('error', () => this.fail(new UserReadError('NOT_CONNECTED', 'Owner read connection failed')));
    try {
      const description = await this.request('describe');
      if (description?.version !== USER_READ_VERSION) throw new UserReadError('VERSION_MISMATCH', 'Owner read protocol version is unsupported');
    } catch (e) { this.close(); throw e; }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.fail(new UserReadError('NOT_CONNECTED', 'Owner read connection closed'));
    this.socket?.destroy(); this.child?.stdin?.end(); this.child?.kill();
    this.input?.destroy(); this.output?.destroy(); this.buffer = Buffer.alloc(0);
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > USER_READ_LIMITS.responseBytes) this.close();
        return;
      }
      if (newline > USER_READ_LIMITS.responseBytes) { this.close(); return; }
      const bytes = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
      let response: any;
      try { response = JSON.parse(bytes.toString('utf8')); } catch { this.fail(new UserReadError('USER_API_UNAVAILABLE', 'Owner bridge did not return the expected protocol')); this.close(); return; }
      const p = this.pending.get(response?.id); if (!p) continue;
      clearTimeout(p.timer); this.pending.delete(response.id);
      if (response.error) p.reject(new UserReadError(response.error.code || 'INTERNAL', response.error.message || 'Owner read failed'));
      else p.resolve(response.result);
    }
  }
  private request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.output || this.closed) return Promise.reject(new UserReadError('NOT_CONNECTED', 'Owner read connection unavailable'));
    if (this.pending.size >= 2) return Promise.reject(new UserReadError('BUSY', 'Wait for the current owner read requests'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new UserReadError('TIMEOUT', 'Owner read timed out; no write was attempted')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      const text = JSON.stringify({ id, method, params });
      if (Buffer.byteLength(text) > USER_READ_LIMITS.requestBytes) { clearTimeout(timer); this.pending.delete(id); reject(new UserReadError('INVALID_ARGUMENT', 'Owner read request is too large')); return; }
      this.output!.write(text + '\n');
    });
  }
  status(): ReturnType<UserReader['status']> { return this.request('status'); }
  rooms(): Promise<UserRoom[]> { return this.request('rooms'); }
  history(chatId: string, before?: string): Promise<UserHistory> { return this.request('history', { chatId, ...(before ? { before } : {}) }); }
  updates(chatId: string, after: string, visibleIds: string[], versions?: Record<string, string>): Promise<UserUpdates> { return this.request('updates', { chatId, after, visibleIds, ...(versions ? { versions } : {}) }); }
}
