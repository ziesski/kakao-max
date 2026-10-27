// ----------------------------------------------------------------------------
// The account's chat list and per-chat metadata, independent of the transport.
//
// Sources: LOGINLIST on every (re)connect, chats remembered in KnownChats (which
// LOGINLIST may omit), CREATE results, and pushed messages for chats we have not
// seen. Metadata (title, members) is fetched lazily through `fetchMeta` and
// enriched with the user's custom friend nicknames. Large groups list only some
// members in that metadata; other message authors are looked up by id through
// `fetchMembers` (LOCO MEMBER) and cached.
// ----------------------------------------------------------------------------

import type { ChannelMember, ChannelMeta, IncomingMessage } from '@kakao-max/protocol';
import type { KnownChats } from './known-chats.ts';
import type { MessageStore } from './message-store.ts';
import type { FriendsStore } from './friends.ts';
import { previewText } from './preview.ts';
import { isGroupType } from './chat-types.ts';
import { toKakaoError } from './errors.ts';

export interface ChatSummary {
  id: string;
  type: string;
  /** null when an archived/remembered room has no authoritative unread count. */
  unreadCount: number | null;
  lastMessage: string;
  lastSendAt?: number;
  maxLogId: string;
  title?: string;
  titleSource?: ChannelMeta['titleSource'];
  isGroup?: boolean;
  memberCount?: number;
  profileImageUrl?: string;
  profileImageUrls?: string[];
}

/** The subset of a LOGINLIST conversation the registry needs. */
export interface LoginListConversation {
  id: string;
  type: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageType?: number;
  lastSendAt?: number;
  memberCount?: number;
  raw?: unknown;
}

export type ChatFilter = 'all' | 'direct' | 'group';

export interface ChatRegistryDeps {
  knownChats: KnownChats;
  store: MessageStore;
  friends: FriendsStore;
  selfUserId: () => string;
  /** Fetch fresh metadata from the server (throws when disconnected). */
  fetchMeta: (chatId: string) => Promise<ChannelMeta>;
  /** Fetch specific members by userId (LOCO MEMBER; throws when disconnected). */
  fetchMembers?: (chatId: string, userIds: string[]) => Promise<ChannelMember[]>;
  log: (line: string) => void;
}

export class ChatRegistry {
  private readonly chats = new Map<string, ChatSummary>();
  private readonly metaTimes = new Map<string, number>();
  private readonly metaCache = new Map<string, ChannelMeta>();
  /** Authors resolved by `resolveAuthors`, per chat: userId → name. */
  private readonly authorNames = new Map<string, Map<string, string>>();
  /** userIds already asked for, per chat, so a member who left is not re-fetched on every read. */
  private readonly authorsAsked = new Map<string, Set<string>>();
  private readonly deps: ChatRegistryDeps;

  constructor(deps: ChatRegistryDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.chats.size;
  }

  get(chatId: string): ChatSummary | undefined {
    return this.chats.get(chatId);
  }

  /** Replace/refresh from a LOGINLIST, then re-add remembered chats it omitted. */
  loadLoginList(conversations: LoginListConversation[]): { fromLoginList: number; remembered: number } {
    this.metaCache.clear(); this.metaTimes.clear();
    for (const conv of conversations) {
      const last = (conv.raw as any)?.l;
      let profileImageUrl: string | undefined;
      const profileImageUrls: string[] = [];
      const selfUserId = this.deps.selfUserId();
      if (conv.type === 'DirectChat') {
        const otherUserId = (conv.raw as any)?.i?.find((id: any) => String(id) !== selfUserId);
        if (otherUserId) {
          profileImageUrl = this.deps.friends.get(String(otherUserId))?.profileImageUrl;
          if (profileImageUrl) profileImageUrls.push(profileImageUrl);
        }
      } else {
        const memberIds = Array.isArray((conv.raw as any)?.i) ? (conv.raw as any).i : [];
        for (const mId of memberIds) {
          if (String(mId) === selfUserId) continue;
          const url = this.deps.friends.get(String(mId))?.profileImageUrl;
          if (url && !profileImageUrls.includes(url)) {
            profileImageUrls.push(url);
            if (profileImageUrls.length >= 4) break;
          }
        }
        if (profileImageUrls.length > 0) profileImageUrl = profileImageUrls[0];
      }
      this.chats.set(conv.id, {
        id: conv.id,
        type: conv.type,
        isGroup: isGroupType(conv.type),
        unreadCount: conv.unreadCount ?? null,
        lastMessage: previewText(conv.lastMessage, conv.lastMessageType),
        memberCount: conv.memberCount,
        lastSendAt: conv.lastSendAt || (typeof last?.sendAt === 'number' ? last.sendAt : typeof last?.s === 'number' ? last.s : undefined),
        maxLogId: last?.logId != null ? String(last.logId) : '0',
        profileImageUrl,
        profileImageUrls: profileImageUrls.length > 0 ? profileImageUrls : undefined
      });
      this.deps.knownChats.remember({ id: conv.id, type: conv.type });
    }
    const fromLoginList = conversations.length;
    let remembered = 0;
    for (const k of this.deps.knownChats.list()) {
      if (this.chats.has(k.id)) continue;
      const stats = this.deps.store.getChatStats(k.id);
      this.chats.set(k.id, {
        id: k.id,
        type: k.type,
        unreadCount: null,
        title: k.title,
        lastMessage: stats.lastMessage != null ? previewText(stats.lastMessage, stats.lastType) : '',
        lastSendAt: stats.lastSendAt,
        maxLogId: '0'
      });
      remembered++;
    }
    return { fromLoginList, remembered };
  }

  /** Chats, most recently active first (chats with no known activity last). */
  list(filter: ChatFilter = 'all'): ChatSummary[] {
    const isGroup = (c: ChatSummary) => isGroupType(c.type) ?? c.isGroup ?? (c.memberCount ?? 0) > 2;
    return [...this.chats.values()]
      .filter((c) => filter === 'all' || (filter === 'group' ? isGroup(c) : !isGroup(c) && c.type !== 'MemoChat'))
      .sort((a, b) => (b.lastSendAt ?? 0) - (a.lastSendAt ?? 0));
  }

  unreadSummary() {
    return [...this.chats.values()]
      .filter((c) => c.unreadCount != null && c.unreadCount > 0)
      .map((c) => ({ chatId: c.id, title: c.title, unreadCount: c.unreadCount, lastMessage: c.lastMessage, isGroup: c.isGroup }));
  }

  cachedMeta(chatId: string): ChannelMeta | undefined {
    return this.metaCache.get(chatId);
  }

  /** Remember one server-resolved existing room without creating a room or changing account state. */
  rememberExisting(meta: ChannelMeta): ChatSummary {
    const existing = this.chats.get(meta.chatId);
    if (existing) return existing;
    const chat: ChatSummary = { id: meta.chatId, type: meta.type ?? (meta.isGroup ? 'MultiChat' : 'DirectChat'),
      title: meta.title, titleSource: meta.titleSource, isGroup: meta.isGroup, memberCount: meta.members.length,
      unreadCount: null, lastMessage: '', maxLogId: meta.lastLogId ?? '0' };
    this.deps.knownChats.remember({ id: chat.id, type: chat.type, title: chat.title });
    this.chats.set(chat.id, chat);
    this.metaCache.set(chat.id, meta);
    this.metaTimes.set(chat.id, Date.now());
    return chat;
  }

  /** Metadata for a chat: cached, or fetched, enriched with friend nicknames, and applied. */
  async getInfo(chatId: string, refresh = false): Promise<ChannelMeta> {
    const cached = this.metaCache.get(chatId);
    if (cached && !refresh && Date.now() - (this.metaTimes.get(chatId) ?? 0) < 300000) return cached;
    const meta = await this.deps.fetchMeta(chatId);
    // The type code wins over member counting: a MultiChat with 2 members left is still a group.
    const byType = isGroupType(meta.type ?? this.chats.get(chatId)?.type);
    if (byType !== undefined) meta.isGroup = byType;
    for (const m of meta.members) {
      const f = this.deps.friends.get(m.userId);
      if (f?.friendNickName) m.name = f.friendNickName;
    }
    // A 1:1 without an explicit title is named after the other member.
    let directProfileUrl: string | undefined;
    const groupProfileUrls: string[] = [];
    const self = this.deps.selfUserId();
    // KakaoTalk's own name for the memo chat; it has no other member to be named after.
    if (meta.type === 'MemoChat' && (!meta.titleSource || meta.titleSource === 'participants')) meta.title = '나와의 채팅';
    if (!meta.isGroup) {
      const other = meta.members.find((m) => m.userId !== self);
      if (other) {
        if (!meta.titleSource || meta.titleSource === 'participants') meta.title = other.name;
        directProfileUrl = other.profileImageUrl || this.deps.friends.get(other.userId)?.profileImageUrl;
      }
    } else {
      for (const m of meta.members) {
        if (m.userId === self) continue;
        const url = m.profileImageUrl || this.deps.friends.get(m.userId)?.profileImageUrl;
        if (url && !groupProfileUrls.includes(url)) {
          groupProfileUrls.push(url);
          if (groupProfileUrls.length >= 4) break;
        }
      }
    }
    this.metaCache.set(chatId, meta);
    this.metaTimes.set(chatId, Date.now());
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.title = meta.title;
      chat.titleSource = meta.titleSource;
      chat.isGroup = meta.isGroup;
      if (directProfileUrl) {
        chat.profileImageUrl = directProfileUrl;
        chat.profileImageUrls = [directProfileUrl];
      } else if (groupProfileUrls.length > 0) {
        chat.profileImageUrl = groupProfileUrls[0];
        chat.profileImageUrls = groupProfileUrls;
      }
      // The server's type wins; guessing from members would store a memo chat found mid-session as DirectChat.
      if (meta.type) chat.type = meta.type;
      else if (!chat.type) chat.type = meta.isGroup ? 'MultiChat' : 'DirectChat';
      if (meta.lastLogId) chat.maxLogId = meta.lastLogId;
      this.deps.knownChats.remember({ id: chatId, type: chat.type, title: meta.title });
    }
    return meta;
  }

  /** Resolve titles for every untitled chat, spaced out to stay polite to the server. */
  async resolveAll(delayMs = 120): Promise<void> {
    for (const chat of [...this.chats.values()]) {
      if (chat.title) continue;
      try {
        await this.getInfo(chat.id);
      } catch (e) {
        this.deps.log(`room metadata unresolved (shown untitled): ${toKakaoError(e).code}`);
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  /** The loaded 1:1 chat with `userId`, checking cached metadata first, then fetching. */
  async findDirectChatWith(userId: string): Promise<{ chatId: string; title: string } | undefined> {
    const matches = (meta: ChannelMeta) => !meta.isGroup && meta.members.some((m) => m.userId === userId);
    for (const chat of this.chats.values()) {
      const meta = chat.type === 'DirectChat' ? this.metaCache.get(chat.id) : undefined;
      if (meta && matches(meta)) return { chatId: chat.id, title: meta.title };
    }
    for (const chat of this.chats.values()) {
      if (chat.type !== 'DirectChat' || this.metaCache.has(chat.id)) continue;
      try {
        const meta = await this.getInfo(chat.id);
        if (matches(meta)) return { chatId: chat.id, title: meta.title };
      } catch (e) {
        // Best effort: one unreadable chat must not block finding the right one.
        this.deps.log(`openDirectChat: room metadata unavailable: ${toKakaoError(e).code}`);
      }
    }
    return undefined;
  }

  /** Track a 1:1 chat just opened via LOCO CREATE. */
  addCreatedDirectChat(chatId: string, title?: string): void {
    this.deps.knownChats.remember({ id: chatId, type: 'DirectChat', title });
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { id: chatId, type: 'DirectChat', unreadCount: 0, lastMessage: '', maxLogId: '0', title: title || 'DirectChat', isGroup: false });
    }
  }

  remove(chatId: string): void {
    this.chats.delete(chatId);
    this.metaCache.delete(chatId);
    this.metaTimes.delete(chatId);
  }

  /**
   * Apply a received/sent message to its chat. Returns true when the chat was not
   * known before (the caller should resolve its metadata).
   */
  noteMessage(m: IncomingMessage): boolean {
    let chat = this.chats.get(m.chatId);
    const isNew = !chat;
    if (!chat) {
      chat = { id: String(m.chatId), type: '', unreadCount: 0, lastMessage: '', maxLogId: '0' };
      this.chats.set(chat.id, chat);
      this.deps.knownChats.remember({ id: chat.id, type: '' });
    }
    chat.lastMessage = previewText(m.text, m.type);
    chat.lastSendAt = m.sendAt || Math.floor(Date.now() / 1000);
    if (m.messageId) chat.maxLogId = m.messageId;
    // Our own message (from any device) means we've seen the chat; others' add to unread.
    if (m.authorId && String(m.authorId) === this.deps.selfUserId()) chat.unreadCount = 0;
    else if (m.authorId && chat.unreadCount !== null) chat.unreadCount += 1;
    return isNew;
  }

  /** Set a known chat's unread count from the server. Returns false for chats not in the registry. */
  setUnread(chatId: string, count: number): boolean {
    const chat = this.chats.get(chatId);
    if (!chat) return false;
    chat.unreadCount = count;
    return true;
  }

  /** After marking read up to `watermark`, clear unread if it covers the newest message. */
  markReadUpTo(chatId: string, watermark: string): void {
    const chat = this.chats.get(chatId);
    if (chat && BigInt(watermark) >= BigInt(chat.maxLogId || 0)) chat.unreadCount = 0;
  }

  /** The author's display name in this chat, from cached metadata or authors resolved earlier. */
  authorName(chatId: string, authorId: string | undefined): string | undefined {
    if (!authorId) return undefined;
    const fromMeta = this.metaCache.get(chatId)?.members.find((mm) => mm.userId === authorId)?.name;
    if (fromMeta) return fromMeta;
    const resolved = this.authorNames.get(chatId)?.get(authorId);
    if (!resolved) return undefined;
    return this.deps.friends.get(authorId)?.friendNickName || resolved;
  }

  /** The author's profile image URL in this chat, from cached metadata or friends store. */
  authorProfileUrl(chatId: string, authorId: string | undefined): string | undefined {
    if (!authorId) return undefined;
    const fromMeta = this.metaCache.get(chatId)?.members.find((mm) => mm.userId === authorId)?.profileImageUrl;
    if (fromMeta) return fromMeta;
    return this.deps.friends.get(authorId)?.profileImageUrl;
  }

  /**
   * Make `authorName` answer for these authors: load the chat's metadata if needed, then fetch the
   * authors it does not list (LOCO MEMBER, 100 per request). Each userId is asked for once per chat;
   * a failed request is forgotten so it is retried later. Returns how many names were added.
   */
  async resolveAuthors(chatId: string, authorIds: Iterable<string | undefined>): Promise<number> {
    if (!this.deps.fetchMembers) return 0;
    try {
      await this.getInfo(chatId);
    } catch (e) {
      this.deps.log(`author metadata unavailable: ${toKakaoError(e).code}`);
      return 0;
    }
    const asked = this.authorsAsked.get(chatId) ?? new Set<string>();
    this.authorsAsked.set(chatId, asked);
    const missing = [...new Set(authorIds)].filter(
      (id): id is string => Boolean(id) && !asked.has(id!) && !this.authorName(chatId, id)
    );
    let added = 0;
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      batch.forEach((id) => asked.add(id));
      let members: ChannelMember[];
      try {
        members = await this.deps.fetchMembers(chatId, batch);
      } catch (e) {
        batch.forEach((id) => asked.delete(id));
        this.deps.log(`author MEMBER for ${batch.length} failed: ${toKakaoError(e).code}`);
        break;
      }
      const names = this.authorNames.get(chatId) ?? new Map<string, string>();
      this.authorNames.set(chatId, names);
      for (const m of members) {
        if (m.name && m.name !== m.userId && !names.has(m.userId)) {
          names.set(m.userId, m.name);
          added++;
        }
      }
    }
    if (missing.length) this.deps.log(`authors: asked MEMBER for ${missing.length}, named ${added}`);
    return added;
  }
}
