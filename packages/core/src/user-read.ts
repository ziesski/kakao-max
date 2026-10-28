import { createHash } from 'node:crypto';
import { KakaoError } from './errors.ts';
import type { KakaoSession } from './kakao-session.ts';

/** Private owner API, never registered on the agent MCP surface. */
export const USER_READ_VERSION = 1;
export const USER_READ_LIMITS = { history: 30, visible: 200, requestBytes: 16 * 1024, responseBytes: 2 * 1024 * 1024 } as const;
export interface UserRoom { id: string; title?: string; type?: string; memberCount?: number; unreadCount?: number | null; }
export interface UserMessage { messageId: string; authorId: string; authorName?: string; type?: number; text?: string; sendAt?: number; version?: string; }
export interface UserHistory { messages: UserMessage[]; hasMore: boolean; }
export interface UserUpdates { messages: UserMessage[]; removedIds: string[]; reset: boolean; }
export interface UserReader {
  status(): Promise<{ connected: boolean; userId?: string }>;
  rooms(): Promise<UserRoom[]>;
  history(chatId: string, before?: string): Promise<UserHistory>;
  updates(chatId: string, after: string, visibleIds: string[], versions?: Record<string, string>): Promise<UserUpdates>;
}
type UserSession = Pick<KakaoSession, 'getState' | 'listChats' | 'getUserHistory' | 'getUserUpdates'>;
function id(value: unknown, zero = false): string {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n || BigInt(value) < (zero ? 0n : 1n)) {
    throw new KakaoError('INVALID_ARGUMENT', 'Invalid message or room identifier');
  }
  return value;
}
function params(value: unknown, allowed: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
    throw new KakaoError('INVALID_ARGUMENT', 'Invalid owner read request');
  }
  return value as Record<string, any>;
}
const message = (m: any): UserMessage => {
  const value = { messageId: String(m.messageId ?? m.logId), authorId: String(m.authorId),
    authorName: m.authorName, type: m.type, text: m.text, sendAt: m.sendAt };
  return { ...value, version: createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24) };
};

/** Reads the existing account session; no grants, read receipts, writes or account connections. */
export class UserReadService {
  private readonly session: UserSession;
  constructor(session: UserSession) { this.session = session; }
  async dispatch(method: string, value: unknown): Promise<unknown> {
    if (method === 'describe') {
      params(value, []);
      return { version: USER_READ_VERSION, limits: USER_READ_LIMITS, capabilities: ['status', 'rooms', 'history', 'updates'] };
    }
    if (method === 'status') {
      params(value, []); const s = this.session.getState(); return { connected: s.connected, userId: s.userId };
    }
    if (method === 'rooms') {
      params(value, []);
      return this.session.listChats().map(r => ({ id: r.id, title: r.title, type: r.type, memberCount: r.memberCount, unreadCount: r.unreadCount }));
    }
    if (method === 'history') {
      const p = params(value, ['chatId', 'before']);
      const result = await this.session.getUserHistory(id(p.chatId), { limit: USER_READ_LIMITS.history, ...(p.before !== undefined ? { max: id(p.before) } : {}) });
      return { messages: result.messages.map(message), hasMore: result.messages.length === USER_READ_LIMITS.history } satisfies UserHistory;
    }
    if (method === 'updates') {
      const p = params(value, ['chatId', 'after', 'visibleIds', 'versions']);
      if (!Array.isArray(p.visibleIds) || p.visibleIds.length > USER_READ_LIMITS.visible) throw new KakaoError('INVALID_ARGUMENT', 'Invalid visible message window');
      if (p.versions !== undefined && (!p.versions || typeof p.versions !== 'object' || Array.isArray(p.versions) ||
        Object.entries(p.versions).some(([key, v]) => !p.visibleIds.includes(key) || typeof v !== 'string' || !/^[a-f0-9]{24}$/.test(v)))) throw new KakaoError('INVALID_ARGUMENT', 'Invalid visible message versions');
      const result = this.session.getUserUpdates(id(p.chatId), id(p.after, true), p.visibleIds.map((v: unknown) => id(v)));
      const messages = result.messages.map(message);
      return { ...result, messages: result.reset ? messages : messages.filter(m => !p.versions || p.versions[m.messageId] !== m.version) } satisfies UserUpdates;
    }
    throw new KakaoError('INVALID_ARGUMENT', 'Unknown owner read method');
  }
}
