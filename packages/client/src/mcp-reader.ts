import { CONVERSATION_LIMITS, ConversationError, type ConversationReader, type ConversationMessage } from './types.ts';

export interface ToolClient {
  callTool<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  request?(method: string, params?: Record<string, unknown>): Promise<any>;
  onNotification?(listener: (method: string, params: Record<string, any>) => void): () => void;
  onDisconnect?(listener: (error: Error) => void): () => void;
}
const validId = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v);
function messages(value: unknown, liveEvents = false): ConversationMessage[] {
  if (!Array.isArray(value)) throw new ConversationError('INVALID_RESPONSE', '대화 응답 형식이 올바르지 않습니다.');
  // Recent events also carry read receipts, which have no message identity.
  // Keep their server cursor, but do not turn them into conversation messages.
  return value.filter(m => !(liveEvents && m?.type === -1 && m?.raw?.isReadReceipt === true)).map(m => {
    const id = m?.messageId ?? m?.logId;
    if (!validId(id) || !validId(m.authorId)) throw new ConversationError('INVALID_RESPONSE', '대화 식별자가 올바르지 않습니다.');
    return { messageId: id, authorId: m.authorId, authorName: m.authorName, type: m.type, text: m.text, sendAt: m.sendAt };
  });
}

/** The terminal uses exactly the agent tools and policies, with no privileged read transport. */
export class McpConversationReader implements ConversationReader {
  private readonly client: ToolClient;
  private readonly watches = new Map<string, symbol>();
  readonly watch?: NonNullable<ConversationReader['watch']>;
  constructor(client: ToolClient) { this.client = client; if (client.request && client.onNotification) this.watch = this.subscribe.bind(this); }
  async status(): ReturnType<ConversationReader['status']> {
    const s = await this.client.callTool('get_status');
    const mode = s.agentMode?.mode;
    return { connected: s.connected === true, userId: s.userId == null ? undefined : String(s.userId),
      ...(mode === 'ask' || mode === 'trust' ? { mode } : {}) };
  }
  async rooms(): ReturnType<ConversationReader['rooms']> {
    const result = await this.client.callTool('list_chats');
    if (!Array.isArray(result.chats) || result.chats.some((r: any) => !validId(r?.id))) throw new ConversationError('INVALID_RESPONSE', '방 목록 응답 형식이 올바르지 않습니다.');
    return result.chats.map((r: any) => ({ id: r.id, title: r.title, type: r.type, memberCount: r.memberCount, unreadCount: r.unreadCount }));
  }
  async history(chatId: string, before?: string): ReturnType<ConversationReader['history']> {
    // Phone reads do not push unread metadata to this device. Refresh the exact
    // room before the daemon checks its cached unread count; this marks nothing read.
    await this.client.callTool('list_chats', { chatId, refreshReadState: true });
    const result = await this.client.callTool('read_messages', { chatId, limit: CONVERSATION_LIMITS.history, ...(before ? { beforeLogId: before } : {}) });
    if (result.sync?.error || result.sync?.status !== undefined && ![0, -203].includes(result.sync.status)) throw new ConversationError('NETWORK', '대화를 가져오지 못했습니다. Ctrl+R로 다시 조회하세요.');
    const rows = messages(result.messages);
    if (result.liveCursor !== undefined && (!Number.isSafeInteger(result.liveCursor) || result.liveCursor < 0)) throw new ConversationError('INVALID_RESPONSE', '대화 갱신 위치를 확인할 수 없습니다.');
    return { messages: rows, hasMore: rows.length === CONVERSATION_LIMITS.history, ...(result.liveCursor !== undefined ? { cursor: result.liveCursor } : {}) };
  }
  private async subscribe(chatId: string, changed: () => void, failed: (error: Error) => void): Promise<() => void> {
    if (!this.client.request || !this.client.onNotification) throw new ConversationError('NOT_SUPPORTED', '이벤트 구독을 지원하는 데몬과 연결 프로그램이 필요합니다.');
    const uri = `kakao://rooms/${chatId}/messages`, token = Symbol();
    this.watches.set(uri, token);
    let active = true, subscriptionId: string | undefined;
    const unnotify = this.client.onNotification((method, params) => {
      if (!active || this.watches.get(uri) !== token || method !== 'notifications/resources/updated' || params.uri !== uri || params._meta?.subscriptionId !== subscriptionId) return;
      const code = params._meta?.error?.code;
      if (typeof code === 'string') failed(new ConversationError(code, '대화 이벤트 구독이 중지됐습니다.'));
      else changed();
    });
    const undisconnect = this.client.onDisconnect?.(error => { if (active && this.watches.get(uri) === token) failed(error); });
    const dispose = () => {
      if (!active) return; active = false; unnotify(); undisconnect?.();
      if (this.watches.get(uri) === token) {
        this.watches.delete(uri);
        void this.client.request!('resources/unsubscribe', { uri }).catch(() => {});
      }
    };
    try {
      const result = await this.client.request('resources/subscribe', { uri });
      subscriptionId = result._meta?.subscriptionId;
      if (typeof subscriptionId !== 'string' || !subscriptionId) throw new ConversationError('INVALID_RESPONSE', '구독 응답을 확인할 수 없습니다.');
      return dispose;
    } catch (e) { dispose(); throw e; }
  }
  async updates(chatId: string, after: string, visibleIds: string[], cursor = 0): ReturnType<ConversationReader['updates']> {
    const result = await this.client.callTool('read_messages', { chatId, mode: 'recent', sinceSeq: cursor });
    if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor) throw new ConversationError('INVALID_RESPONSE', '대화 갱신 위치를 확인할 수 없습니다. 다시 연결하세요.');
    const visible = new Set(visibleIds);
    const rows = messages(result.messages, true).filter(m => visible.has(m.messageId) || BigInt(m.messageId) > BigInt(after));
    // History owns the initial window; replaying the feed must not append older messages.
    // Existing MCP recent has no deletion snapshot. Explicit refresh reconciles history.
    return { messages: rows.slice(-CONVERSATION_LIMITS.visible), removedIds: [], reset: false, cursor: result.cursor, ...(result.hasMore === true ? { more: true } : {}) };
  }
}
