// ----------------------------------------------------------------------------
// Minimal MCP client for the CLI: newline-delimited JSON-RPC 2.0 over TCP to the
// always-on daemon (apps/mcp, KAKAO_MCP_LISTEN). The CLI talks ONLY to the daemon,
// the same surface agents use, so what the CLI verifies is what agents get.
//
// callTool() unwraps the MCP tool result: JSON text is parsed, and an `isError`
// result is thrown as McpToolError so failures never masquerade as data.
// ----------------------------------------------------------------------------

import net from 'node:net';
import readline from 'node:readline';

export class McpToolError extends Error {
  readonly tool: string;
  /** KakaoError code from the daemon (e.g. POLICY_DENIED), or INTERNAL when absent. */
  readonly code: string;
  readonly retryable: boolean;
  /** Structured error details from the daemon (e.g. details.passkey.approvalUrl on APPROVAL_REQUIRED). */
  readonly details?: Record<string, unknown>;
  constructor(tool: string, message: string, code = 'INTERNAL', retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'McpToolError';
    this.tool = tool;
    this.code = code;
    this.retryable = retryable;
    if (details) this.details = details;
  }
}

interface Pending {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ElicitationReply {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
export type ElicitationHandler = (params: Record<string, any>) => Promise<ElicitationReply>;

export class McpClient {
  private socket?: net.Socket;
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly onElicitation?: ElicitationHandler;
  private asking = false;
  private readonly notifications = new Set<(method: string, params: Record<string, any>) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  get connected(): boolean { return !!this.socket && !this.socket.destroyed; }
  onNotification(listener: (method: string, params: Record<string, any>) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }


  constructor(opts: { host: string; port: number; timeoutMs?: number; onElicitation?: ElicitationHandler }) {
    this.host = opts.host;
    this.port = opts.port;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onElicitation = opts.onElicitation;
  }

  async connect(): Promise<void> {
    if (this.connected) throw new Error('MCP client is already connected');
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(this.port, this.host, () => { s.setTimeout(0); resolve(); });
      s.setTimeout(10000, () => s.destroy(new Error('MCP connection timed out')));
      s.once('error', reject);
      this.socket = s;
    });
    const s = this.socket!;
    s.on('error', (e) => { if (s === this.socket) this.failAll(Object.assign(e, { code: 'NETWORK' })); });
    s.on('close', () => {
      if (s !== this.socket) return;
      this.socket = undefined;
      const error = Object.assign(new Error('MCP daemon closed the connection'), { code: 'NOT_CONNECTED' });
      this.failAll(error);
      for (const listener of [...this.disconnects]) listener(error);
    });
    // readline re-emits socket errors, already reported through failAll above.
    readline.createInterface({ input: s }).on('error', () => {}).on('line', (line) => this.onLine(line));
    try { await this.request('initialize', {
      clientInfo: { name: 'kakao-max-cli', version: '0.1.0' },
      ...(this.onElicitation ? { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } } } : {})
    }, 10000); } catch (e) { this.close(); throw e; }
  }

  /** Raw JSON-RPC request; rejects on a JSON-RPC error or timeout. */
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(Object.assign(new Error('MCP client is not connected'), { code: 'NOT_CONNECTED' }));
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Call an MCP tool and return its parsed result; throws McpToolError on isError. */
  async callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request('tools/call', { name, arguments: args });
    const text: string | undefined = res?.content?.[0]?.text;
    if (res?.isError) {
      const e = res.structuredContent?.error;
      if (e?.message) throw new McpToolError(name, e.message, e.code, e.retryable === true, e.details);
      throw new McpToolError(name, (text ?? 'unknown error').replace(/^Error(?: \[\w+\])?:\s*/, ''));
    }
    if (text == null) throw new McpToolError(name, 'empty tool result');
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  close(): void {
    const socket = this.socket; this.socket = undefined; socket?.destroy();
    this.failAll(Object.assign(new Error('MCP client closed'), { code: 'NOT_CONNECTED' }));
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC frame (the daemon only writes JSON, so this is noise)
    }
    if (msg.method === 'elicitation/create' && (typeof msg.id === 'string' || typeof msg.id === 'number')) {
      if (!this.onElicitation || this.asking || !this.pending.size) {
        this.socket?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }) + '\n');
        return;
      }
      this.asking = true;
      const socket = this.socket;
      const waiting = [...this.pending.keys()];
      void this.onElicitation(msg.params ?? {}).catch((): ElicitationReply => ({ action: 'cancel' })).then(result => {
        // Never send a late answer on a replacement connection or after the calling request timed out.
        if (socket && !socket.destroyed && socket === this.socket && waiting.some(id => this.pending.has(id))) {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        }
      }).finally(() => { this.asking = false; });
      return;
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      for (const listener of [...this.notifications]) listener(msg.method, msg.params ?? {});
      return;
    }
    const p = msg.id != null ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'MCP request failed'), { code: msg.error.data?.code ?? (msg.error.code === -32601 ? 'NOT_SUPPORTED' : 'INVALID_RESPONSE') }));
    else p.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
