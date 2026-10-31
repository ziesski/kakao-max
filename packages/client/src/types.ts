/** UI contracts, independent of the daemon's transport and account implementation. */
export const CONVERSATION_LIMITS = { history: 30, visible: 200 } as const;
export interface ConversationRoom { id: string; title?: string; type?: string; memberCount?: number; unreadCount?: number | null; }
export interface ConversationMessage { messageId: string; authorId: string; authorName?: string; type?: number; text?: string; sendAt?: number; }
export interface ConversationHistory { messages: ConversationMessage[]; hasMore: boolean; cursor?: number; }
export interface ConversationUpdates { messages: ConversationMessage[]; removedIds: string[]; reset: boolean; cursor?: number; more?: boolean; }
export interface ConversationReader {
  status(): Promise<{ connected: boolean; userId?: string; mode?: 'ask' | 'trust' }>;
  rooms(): Promise<ConversationRoom[]>;
  history(chatId: string, before?: string): Promise<ConversationHistory>;
  watch?(chatId: string, changed: () => void, failed: (error: Error) => void): Promise<() => void>;
  updates(chatId: string, after: string, visibleIds: string[], cursor?: number): Promise<ConversationUpdates>;
}
export class ConversationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
