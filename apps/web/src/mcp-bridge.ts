import net from 'node:net';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

/** A kakao-max tool error; APPROVAL_REQUIRED carries the passkey page link when the daemon has one. */
export class McpToolError extends Error {
  readonly code?: string;
  readonly approvalUrl?: string;
  readonly retryable: boolean;
  constructor(message: string, code?: string, approvalUrl?: string, retryable = false) {
    super(message);
    this.code = code;
    this.approvalUrl = approvalUrl;
    this.retryable = retryable;
  }
}

/**
 * The bridge itself failed, not the daemon's tool. `uncertain` is true once the request may have
 * reached the daemon (connection lost mid-call, timeout, protocol error): the action may have happened.
 */
export type McpTransportCode = 'DAEMON_NOT_CONNECTED' | 'CONNECTION_LOST' | 'TIMEOUT' | 'RPC_ERROR';
export class McpTransportError extends Error {
  readonly code: McpTransportCode;
  readonly uncertain: boolean;
  constructor(code: McpTransportCode, message: string) {
    super(message);
    this.code = code;
    this.uncertain = code !== 'DAEMON_NOT_CONNECTED';
  }
}

/**
 * The daemon's confirmation dialog for one action the person started in the GUI (MCP form elicitation).
 * `message` is rendered by the daemon and contains agent- or room-supplied text: show it as plain text only.
 */
export interface ApprovalDialog {
  id: string;
  message: string;
  codeTitle: string;
  codeDescription: string;
  /** Present when the daemon offers "don't ask again" for this room. */
  rememberTitle?: string;
}
/** The person's answer. `accept` carries the confirmation code they typed; the GUI never fills it in. */
export type ApprovalAnswer = { action: 'accept'; code: string; remember: boolean } | { action: 'decline' } | { action: 'cancel' };

/** Parse a daemon `elicitation/create` request into a dialog, or undefined when it is not the shape the GUI can show. */
export function parseApprovalDialog(id: unknown, params: any): ApprovalDialog | undefined {
  if ((typeof id !== 'string' && typeof id !== 'number') || !params || typeof params.message !== 'string') return undefined;
  if (params.mode !== undefined && params.mode !== 'form') return undefined;
  const props = params.requestedSchema?.properties;
  const code = props?.code, remember = props?.remember;
  if (!code || code.type !== 'string') return undefined;
  const extra = Object.keys(props).filter(k => k !== 'code' && k !== 'remember');
  if (extra.length || (remember && remember.type !== 'boolean')) return undefined;
  return {
    id: String(id), message: params.message,
    codeTitle: typeof code.title === 'string' ? code.title : '확인 코드',
    codeDescription: typeof code.description === 'string' ? code.description : '',
    ...(remember ? { rememberTitle: typeof remember.title === 'string' ? remember.title : '앞으로 묻지 않기' } : {})
  };
}

export interface McpBridgeOptions {
  host?: string;
  port?: number;
  /** Wait between reconnect attempts (default 3000). */
  reconnectDelayMs?: number;
  /** How long the MCP `initialize` handshake may take before the socket is dropped (default 10000). */
  initTimeoutMs?: number;
  /** How long one tool call may take, including a confirmation dialog the person answers (default 150000). */
  callTimeoutMs?: number;
}

export interface ChatMetaResponse {
  chatId: string;
  title: string;
  isGroup: boolean;
  lastLogId?: string;
  members: Array<{ userId: string; name: string; profileImageUrl?: string }>;
}

export class McpBridge extends EventEmitter {
  private socket?: net.Socket;
  private rl?: readline.Interface;
  private reqId = 0;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private cursor = 0;
  private isPolling = false;
  private closing = false;
  readonly host: string;
  readonly port: number;
  private _connected = false;

  private readonly reconnectDelayMs: number;
  private readonly initTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  /** The in-flight connect, shared by concurrent callers. */
  private connecting?: Promise<void>;
  /** Daemon dialog requests waiting for the person, by JSON-RPC id. */
  private dialogs = new Map<string, string | number>();

  constructor(opts: McpBridgeOptions = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 8787;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3000;
    this.initTimeoutMs = opts.initTimeoutMs ?? 10000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 150000;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Connect and run the MCP handshake. A call while a connect is in flight shares it;
   * after close() it rejects, since close() is final. Once connected, a dropped socket
   * reconnects on its own every reconnectDelayMs.
   */
  connect(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('MCP bridge is closed'));
    if (this._connected) return Promise.resolve();
    this.connecting ??= this.openSocket().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const finishConnect = (err?: Error) => {
        if (!resolved) {
          resolved = true;
          if (err) reject(err);
          else resolve();
        }
      };

      const s = net.connect(this.port, this.host, async () => {
        this.socket = s;
        this.rl = readline.createInterface({ input: s });
        this.rl.on('line', (line) => this.onLine(line));
        this.rl.on('error', () => {});

        // A daemon that accepts but never answers would otherwise hold the connect forever.
        const initTimer = setTimeout(() => s.destroy(new Error(`MCP initialize timed out after ${this.initTimeoutMs}ms`)), this.initTimeoutMs);
        try {
          // Declaring form elicitation lets the daemon ask the person through this GUI instead of refusing.
          await this.call('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'kakao-max-web', version: '0.1.0' } });
          clearTimeout(initTimer);
          this._connected = true;
          this.emit('connected');
          finishConnect();
        } catch (e) {
          clearTimeout(initTimer);
          s.destroy();
          finishConnect(e as Error);
        }
      });

      s.on('error', (err) => {
        this.emit('error', err);
        finishConnect(err);
      });

      s.on('close', () => {
        this._connected = false;
        this.emit('disconnected');
        this.cleanup();
        if (!this.closing) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /** At most one reconnect timer at a time; a failed attempt's socket close schedules the next. */
  private scheduleReconnect(): void {
    if (this.closing || this._connected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {
        // Reported through the 'error' event; the socket's close schedules the next attempt.
      });
    }, this.reconnectDelayMs);
  }

  private cleanup(): void {
    // The daemon drops its own side of any open dialog with the connection.
    for (const id of this.dialogs.keys()) this.emit('approval-closed', id);
    this.dialogs.clear();
    for (const [, { reject }] of this.pending) {
      reject(new McpTransportError('CONNECTION_LOST', 'Daemon connection disconnected before it answered; the action may or may not have happened'));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = undefined;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = undefined;
  }

  /** Final: stops reconnecting and the inbound stream. */
  close(): void {
    this.closing = true;
    this._connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.destroy();
    this.cleanup();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.method === 'elicitation/create' && msg.id != null) {
        this.onDialogRequest(msg.id, msg.params);
        return;
      }
      if (msg.method === 'ping' && msg.id != null) {
        this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new McpTransportError('RPC_ERROR', msg.error.message || 'JSON-RPC error'));
        } else {
          resolve(msg.result);
        }
      }
    } catch (e) {
      console.warn('[bridge] invalid line from MCP:', trimmed.slice(0, 100));
    }
  }

  private write(obj: unknown): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(obj) + '\n');
  }

  /** A dialog nobody can show is cancelled at once, so the daemon does not wait for its timeout. */
  private onDialogRequest(id: string | number, params: unknown): void {
    const dialog = parseApprovalDialog(id, params);
    if (!dialog || this.dialogs.has(dialog.id) || this.listenerCount('approval') === 0) {
      this.write({ jsonrpc: '2.0', id, result: { action: 'cancel' } });
      return;
    }
    this.dialogs.set(dialog.id, id);
    this.emit('approval', dialog);
  }

  /** Dialogs the daemon is still waiting on. */
  pendingApprovalIds(): string[] {
    return [...this.dialogs.keys()];
  }

  /** Send the person's answer for one open dialog. False when it is no longer open. */
  answerApproval(dialogId: string, answer: ApprovalAnswer): boolean {
    const id = this.dialogs.get(dialogId);
    if (id === undefined) return false;
    this.dialogs.delete(dialogId);
    const result = answer.action === 'accept'
      ? { action: 'accept', content: { code: answer.code, remember: answer.remember } }
      : { action: answer.action };
    this.write({ jsonrpc: '2.0', id, result });
    this.emit('approval-closed', dialogId);
    return true;
  }

  private call(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new McpTransportError('DAEMON_NOT_CONNECTED', 'Not connected to the daemon; nothing was sent'));
      }
      const id = ++this.reqId;
      // A late answer after the timeout is dropped: the caller already reported the outcome as unknown.
      const timer = timeoutMs ? setTimeout(() => {
        if (this.pending.delete(id)) reject(new McpTransportError('TIMEOUT', `The daemon did not answer within ${Math.round(timeoutMs / 1000)}s; the action may or may not have happened`));
      }, timeoutMs) : undefined;
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.socket.write(payload);
    });
  }

  async callTool<T = any>(name: string, args: Record<string, any> = {}): Promise<T> {
    const res = await this.call('tools/call', { name, arguments: args }, this.callTimeoutMs);
    if (res.isError) {
      const error = res.structuredContent?.error;
      throw new McpToolError(res.content?.[0]?.text || 'Tool call failed', error?.code, error?.details?.passkey?.approvalUrl, error?.retryable === true);
    }
    const text = res.content?.[0]?.text;
    if (text) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    return {} as T;
  }

  async getStatus(): Promise<{ userId?: string; connected: boolean; endpoint?: any; chatsCount?: number }> {
    return this.callTool('get_status');
  }

  async listChats(): Promise<{ chats: any[] }> {
    return this.callTool('list_chats');
  }

  async getChatInfo(chatId: string): Promise<ChatMetaResponse> {
    return this.callTool('list_chats', { chatId });
  }

  async getHistory(chatId: string, limit = 50, max?: string): Promise<{ messages: any[] }> {
    return this.callTool('read_messages', { chatId, mode: 'history', limit, ...(max ? { beforeLogId: max } : {}) });
  }

  /**
   * Writes take the caller's requestId: the browser keeps one per draft or action and reuses it after an
   * uncertain outcome, so the daemon replays the same operation instead of performing it twice.
   */
  async sendMessage(
    requestId: string,
    chatId: string,
    text: string,
    opts: {
      reply?: { logId: string; userId: string; text?: string };
      mentions?: { userId: string; at: number[]; len: number }[];
    } = {}
  ): Promise<{ status: number; logId?: string; messageId?: string }> {
    return this.callTool('send_message', {
      requestId,
      chatId,
      text,
      ...(opts.reply ? { replyToLogId: opts.reply.logId, replyToUserId: opts.reply.userId, replyToText: opts.reply.text } : {}),
      ...(opts.mentions && opts.mentions.length ? { mentions: opts.mentions } : {})
    });
  }

  async deleteMessage(requestId: string, chatId: string, logId: string): Promise<{ status: number }> {
    return this.callTool('edit_or_delete_message', { requestId, action: 'delete', chatId, logId });
  }

  async selfDeleteMessages(chatId: string, logIds: string[]): Promise<{ local: true; hidden: string[]; alreadyHidden: string[]; notStored: string[] }> {
    return this.callTool('self_delete_messages', { chatId, logIds });
  }

  async forwardMessage(
    requestId: string,
    chatId: string,
    opts: { text: string; type?: number; extra?: string }
  ): Promise<{ status: number; logId?: string }> {
    return this.callTool('forward_message', { requestId, chatId, text: opts.text, type: opts.type ?? 1, ...(opts.extra ? { extra: opts.extra } : {}) });
  }

  async leaveChat(requestId: string, chatId: string, opts: { silence?: boolean; block?: boolean } = {}): Promise<{ status: number }> {
    return this.callTool('leave_chat', { requestId, chatId, silence: opts.silence === true, block: opts.block === true });
  }

  async markRead(requestId: string, chatId: string, watermark: string): Promise<{ status: number }> {
    return this.callTool('mark_read', { requestId, chatId, watermark });
  }

  /** kakao-max searches one room at a time (read_messages search mode). */
  async searchMessages(query: string, opts: { chatId: string; limit?: number }): Promise<{ count: number; messages: any[] }> {
    return this.callTool('read_messages', { chatId: opts.chatId, mode: 'search', query, ...(opts.limit ? { limit: opts.limit } : {}) });
  }

  async getUnreadSummary(): Promise<{ totalUnreadChats: number; chats: any[] }> {
    const res = await this.callTool<{ chats: any[] }>('list_chats', { unreadOnly: true });
    const chats = res.chats ?? [];
    return { ...res, totalUnreadChats: chats.length, chats };
  }

  async listFriends(query?: string, limit?: number): Promise<{ count: number; friends: any[] }> {
    return this.callTool('list_friends', { ...(query ? { query } : {}), ...(limit ? { limit } : {}) });
  }

  /** Lookup only: creating a missing 1:1 room is create_direct_chat, which always needs the person's approval. */
  async openDirectChat(query: string): Promise<{ ok: boolean; chatId: string; title: string; isNew: boolean; friend?: any }> {
    return this.callTool('open_direct_chat', { query });
  }

  async downloadAttachment(chatId: string, opts: { messageId: string; token: string; isMini?: boolean }): Promise<{ status: number; dataBase64?: string }> {
    return this.callTool('download_attachment', { chatId, messageId: opts.messageId, token: opts.token, isMini: opts.isMini === true });
  }

  async syncFriends(): Promise<{ ok: boolean; totalFriends: number }> {
    return this.callTool('sync_friends');
  }

  startInboundStream(onMessage: (msg: any) => void): void {
    // Roomless subscriptions cannot satisfy per-room access or manual approval.
    // Keep the legacy entry point callable without repeatedly issuing forbidden reads.
    process.stderr.write('[bridge] global inbound content stream disabled by room access policy; use scoped history\n');
  }

  private async pollLoop(onMessage?: (msg: any) => void): Promise<void> {
    while (this.isPolling && !this.closing) {
      if (!this._connected) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      try {
        const res = await this.callTool<{ cursor: number; messages: any[]; timedOut?: boolean }>('wait_for_messages', {
          sinceSeq: this.cursor,
          timeoutMs: 20000
        });
        if (res.cursor != null) {
          this.cursor = res.cursor;
        }
        if (res.messages && res.messages.length > 0) {
          for (const m of res.messages) {
            onMessage?.(m);
            this.emit('message', m);
          }
        }
      } catch (e) {
        if (!this.closing) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  }
}
