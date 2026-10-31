// ----------------------------------------------------------------------------
// KakaoSession: the one live KakaoTalk account, as a coordinator.
//
// Owns the single ResilientLocoSession and wires it to the pieces that hold
// state, each testable on its own:
//   ChatRegistry   chat list, metadata, unread counts      (chat-registry.ts)
//   MessageFeed    recent inbound events for polling       (message-feed.ts)
//   MessageStore / FriendsStore / KnownChats  persistence  (SQLite, db.ts)
//   auth refresh   re-login on token expiry                (auth-refresh.ts)
// The methods below are the account API adapters call; LOCO-backed ones fail
// fast with NOT_CONNECTED while the session is reconnecting.
// ----------------------------------------------------------------------------

import path from 'node:path';
import { parseHistoryRange, historyRangeCursor, type HistoryRangeOptions } from './history-range.ts';
import {
  LocoClient,
  ResilientLocoSession,
  type IncomingMessage,
  type ReadReceipt,
  type ChannelMeta,
  type ModifyMessageResult,
  type WriteResult,
  type LocoPacket,
  Int32,
  Long,
  buildEmoticonExtra,
  getEmoticonType,
  parseEmoticonAttachment,
  type EmoticonAttachment,
  parseLoginList
} from '@kakao-max/protocol';

/** The logId a delete notice (type 0 feed, feedType 14) points at, or undefined. */
function deletedLogIdOf(notice: IncomingMessage | undefined): string | undefined {
  if (!notice || (Number(notice.type ?? 0) & 0x3fff) !== 0 || !notice.text) return undefined;
  // Read logId as text: it is a bare JSON integer above 2^53, which JSON.parse would round
  // (seen live: the last digits came back as zeros).
  const id = /"logId"\s*:\s*"?(\d{1,19})"?/.exec(notice.text)?.[1];
  const feedType = /"feedType"\s*:\s*(\d+)/.exec(notice.text)?.[1];
  return id && feedType === '14' ? id : undefined;
}

/** LOCO message types of emoticons (6 EMOTICON, 12 STICKER, 20 STICKER_ANI, 22 SCON, 25 XCON). */
const EMOTICON_TYPES: ReadonlySet<number> = new Set([6, 12, 20, 22, 25]);
import { RoomAccessPolicy, type ReadApproval, type ReadGrantRef, type ReadGrantTool } from './room-access.ts';
import { CredentialStore } from './credentials.ts';
import { preparePhotoBundle } from './photo-bundle.ts';
import { MessageStore, messageRevision, type StoredMessage } from './message-store.ts';
import { collectSharedLinks, extractScheduleAndTodos } from './curation-tools.ts';
import { LocalVault } from './local-vault.ts';
import { FriendsStore, type KakaoFriend } from './friends.ts';
import { KnownChats } from './known-chats.ts';
import { KakaoDb } from './db.ts';
import { loadConfig, describeConfig, type KakaoConfig } from './config.ts';
import { KakaoError, locoStatusError, toKakaoError } from './errors.ts';
import { backfillHistory, mchatLogsSource } from './history-sync.ts';
import { ChatRegistry, type ChatFilter, type ChatSummary } from './chat-registry.ts';
import { MessageInbox } from './message-inbox.ts';
import { MessageFeed, type BufferedMessage } from './message-feed.ts';
import { createAuthRefresher } from './auth-refresh.ts';
import { AuthReloginBudget } from './auth-relogin-budget.ts';
import { createFrameRecorder } from './frame-recorder.ts';
import { longReplacer } from './long-json.ts';
import {
  ProfileManager,
  type KakaoProfileSummary,
  type KakaoProfileDetail,
  type KakaoFriendProfile,
  type MyProfileResult
} from './profile.ts';

export type { ChatSummary } from './chat-registry.ts';
/** How the account's leaving a room became known: own LEAVE, LEFT push, or LOGINLIST `delChatIds`. */
export type LeftReason = 'leave_chat' | 'other_device' | 'login_list';
export type { BufferedMessage } from './message-feed.ts';

export class KakaoSession {
  readonly config: KakaoConfig;
  private readonly creds: CredentialStore;
  private readonly logSink?: (line: string) => void;
  private readonly session: ResilientLocoSession;
  private readonly refreshAuth: ReturnType<typeof createAuthRefresher>;
  // One SQLite file (<dataDir>/kakao.db) backs all local state; see db.ts.
  private readonly db: KakaoDb;
  private readonly store: MessageStore;
  private readonly friends: FriendsStore;
  private readonly knownChats: KnownChats;
  private readonly chats: ChatRegistry;
  private readonly inbox: MessageInbox;
  private readonly feed = new MessageFeed();
  private readonly roomAccess: RoomAccessPolicy;
  private readonly profile: ProfileManager;
  readonly vault: LocalVault;
  private readonly readerWatermarks = new Map<string, string>();
  private readonly leftListeners: Array<(chatId: string, reason: LeftReason) => void> = [];
  private connected = false;
  private endpoint?: { host: string; port: number };

  /**
   * `deps.session` replaces the live LOCO session (tests inject a fake); everything else, including
   * the SQLite store under `config.dataDir`, is real.
   */
  constructor(config: KakaoConfig = loadConfig(), deps: { session?: ResilientLocoSession; credentials?: CredentialStore; log?: (line: string) => void } = {}) {
    this.config = config;
    this.logSink = deps.log;
    this.log(`config ${describeConfig(config)}`);
    this.db = KakaoDb.open({ dir: config.dataDir });
    this.vault = new LocalVault(this.db, path.join(config.dataDir, 'vault'), this.config, line => this.log(line));
    this.roomAccess = new RoomAccessPolicy(this.db, Date.now, { mode: config.agentMode, isMemoChat: chatId => this.isMemoChat(chatId) });
    this.store = new MessageStore(this.db);
    this.friends = new FriendsStore(this.db, config.client);
    this.profile = new ProfileManager(config.client);
    this.knownChats = new KnownChats(this.db);
    this.creds = deps.credentials ?? CredentialStore.load({ envPath: config.envPath });
    this.inbox = new MessageInbox(this.db, this.selfUserId);
    this.refreshAuth = createAuthRefresher({ config, creds: this.creds,
      budget: new AuthReloginBudget(path.join(config.dataDir, 'auth-relogin.json'), config.tokenRefresh.maxAttempts ?? 3),
      log: line => this.log(line) });
    this.session = deps.session ?? this.createLocoSession(config);
    this.chats = new ChatRegistry({
      knownChats: this.knownChats,
      store: this.store,
      friends: this.friends,
      selfUserId: () => this.selfUserId,
      fetchMeta: (chatId) => {
        this.requireConnected();
        return this.session.getChannelMeta(chatId, this.selfUserId);
      },
      fetchMembers: async (chatId, userIds) => (await this.getMembers(chatId, userIds)).members,
      log: (l) => this.log(l)
    });

    this.session.on('connected', (info: { endpoint: { host: string; port: number }; loginList: any }) => {
      this.connected = true;
      this.endpoint = info.endpoint;
      const { fromLoginList, remembered } = this.chats.loadLoginList(info.loginList.conversations);
      this.log(
        `connected — ${this.chats.size} chats ` +
          `(${fromLoginList} from LOGINLIST, ${remembered} remembered)`
      );
      // Rooms the server dropped for this account while the daemon was away.
      const deleted = info.loginList.raw?.delChatIds;
      if (Array.isArray(deleted)) for (const id of deleted) this.chatLeft(String(id), 'login_list');
      void this.chats.resolveAll();
    });
    this.session.on('reconnecting', (i: { attempt: number; delayMs: number }) => {
      this.connected = false;
      this.log(`reconnecting (attempt ${i.attempt}, in ${i.delayMs}ms)`);
    });
    this.session.on('refreshed', () => this.log('credentials refreshed; reconnecting with new token'));
    this.session.on('message', (m: IncomingMessage) => this.ingest(m));
    this.session.on('read', (r: ReadReceipt) => {
      this.log('read receipt received');
      if (r.chatId && r.watermark) {
        this.noteReaderWatermark(String(r.chatId), r.userId ? String(r.userId) : '', String(r.watermark));
      }
      this.feed.pushReadReceipt(r);
    });
    this.session.on('error', (e: Error) => this.log(`session error: ${toKakaoError(e).code}`));
    // Pushes not yet seen live. Logged so a live test can see whether they arrive.
    this.session.on('syncmodmsg', (m: { chatLog?: IncomingMessage }) =>
      this.log('message modification received')
    );
    // "Delete for everyone" done on another device (✅ 2026-10-20, phone in a 1:1). The push's chatLog
    // is not the deleted message but a type 0 feed notice whose text is
    // {"logId": <deleted>, "byHost", "hidden", "feedType": 14}; the server sets 0x4000 on the target.
    this.session.on('syncdlmsg', (m: { chatLog?: IncomingMessage }) => {
      const notice = m.chatLog;
      const target = deletedLogIdOf(notice);
      this.log('message deletion received');
      if (!notice?.chatId) return;
      if (target) this.store.markDeleted(String(notice.chatId), target);
      // Keep the notice itself, as the server's chat log does.
      if (notice.messageId) this.ingest(notice);
    });
    // Every unsolicited packet except the two handled above, whatever its packet id: the server's
    // way of telling this device about the user's own phone activity is still unknown.
    this.session.on('packet', (pkt: LocoPacket) => {
      if (pkt.header.method !== 'MSG' && pkt.header.method !== 'DECUNREAD') {
        const d = (pkt.data || {}) as Record<string, unknown>;
        // SYNCACTION {userId, chatId, type, logId} is a
        // candidate for "the user read this chat on the phone". Log only what tells that apart, no ids.
        if (pkt.header.method === 'SYNCACTION') this.log('account activity received');
        // LEFT {chatId, lastTokenId, serviceId}: the account left a room on another device (✅ 2026-10-25, phone).
        if (pkt.header.method === 'LEFT' && d.chatId != null) this.chatLeft(String(d.chatId), 'other_device');
      }
    });
  }

  private createLocoSession(config: KakaoConfig): ResilientLocoSession {
    const c = this.creds.get();
    const loco = new LocoClient(config.client.appVersion, config.client.os);
    return new ResilientLocoSession({
      loco,
      userId: c.userId,
      accessToken: c.accessToken,
      deviceUUID: c.deviceUUID,
      session: {
        appVersion: config.client.appVersion,
        os: config.client.os,
        pingIntervalMs: 30000,
        connectTimeoutMs: 7000,
        onFrame: config.recordFile ? createFrameRecorder(config.recordFile, (l) => this.log(l)) : undefined
      },
      open: { maxAllocations: 5 },
      reconnect: { baseDelayMs: 1000, maxDelayMs: 15000 },
      isAuthFailure: status => status === -950,
      onAuthFailure: this.refreshAuth,
      log: (l) => this.log(l)
    });
  }

  async start(): Promise<void> {
    const list = await this.session.start();
    if (list.status !== 0) {
      throw new KakaoError(
        list.status === -101 ? 'PC_SESSION_CONFLICT' : 'AUTH_EXPIRED',
        `Account connection was rejected (LOGINLIST status ${list.status}). ` +
          'Review saved account credentials and the bounded re-login state; retain the registered device.',
        { details: { command: 'LOGINLIST', status: list.status } }
      );
    }
    // Asynchronously synchronize the KakaoTalk friends list
    void this.friends.sync(this.creds.get()).then(
      (count) => this.log(`friends synced: ${count} contacts in address book`),
      (e) => this.log(`friends sync failed (cached list kept, ${this.friends.size} contacts): ${toKakaoError(e).code}`)
    );
  }

  /** Fail fast with a retryable error instead of letting a LOCO call hang or crash while reconnecting. */
  private requireConnected(): void {
    if (!this.connected) {
      throw new KakaoError('NOT_CONNECTED', 'KakaoTalk session is not connected (reconnecting); retry shortly');
    }
  }

  get selfUserId(): string {
    return this.creds.get().userId;
  }

  getState() {
    return {
      userId: this.selfUserId,
      connected: this.connected,
      endpoint: this.endpoint,
      chatCount: this.chats.size,
      friendsCount: this.friends.size
    };
  }

  /** Chats, most recently active first (chats with no known activity last). */
  listChats(filter: ChatFilter = 'all'): ChatSummary[] {
    return this.chats.list(filter).map(chat => ({ ...chat, lastMessage: '' }));
  }

  listFriends(query?: string, limit?: number): KakaoFriend[] {
    return this.friends.search(query, limit);
  }

  getFriend(userId: string): KakaoFriend | undefined {
    return this.friends.get(userId);
  }

  findFriend(queryOrUserId: string): KakaoFriend | undefined {
    return this.friends.find(queryOrUserId);
  }

  async syncFriends(force = true): Promise<number> {
    return this.friends.sync(this.creds.get(), force);
  }

  /**
   * Find or create/open a 1:1 direct chat with a friend by query (e.g. "홍길동") or userId.
   * LOCO CREATE is only issued when `allowCreate` is set; otherwise a friend with no
   * loaded 1:1 chat yields `chatId: null` so the caller can ask for approval first.
   */
  async openDirectChat(
    queryOrUserId: string,
    opts: { allowCreate?: boolean; beforeCreate?: (userId: string) => void } = {}
  ): Promise<{ chatId: string | null; title: string; isNew: boolean; friend?: KakaoFriend }> {
    const friend = this.friends.find(queryOrUserId);
    const targetUserId = friend ? friend.userId : (queryOrUserId.match(/^\d+$/) ? queryOrUserId : undefined);
    if (!targetUserId) {
      throw new KakaoError('NOT_FOUND', `Friend not found for "${queryOrUserId}"`, { details: { query: queryOrUserId } });
    }

    const existing = await this.chats.findDirectChatWith(targetUserId);
    if (existing) return { ...existing, isNew: false, friend };

    // 2. Not in active chats list — call LOCO CREATE to open/resolve the 1:1 chat room
    const targetName = friend ? (friend.friendNickName || friend.nickName) : undefined;
    if (!opts.allowCreate) {
      return { chatId: null, title: targetName || targetUserId, isNew: false, friend };
    }
    opts.beforeCreate?.(targetUserId);
    const res = await this.session.createChat([targetUserId], { pushAlert: true, nickName: targetName });
    if (res.status !== 0 || !res.chatId) {
      throw locoStatusError('CREATE', res.status);
    }

    const chatId = res.chatId;
    this.chats.addCreatedDirectChat(chatId, targetName);

    const meta = await this.getChatInfo(chatId).catch((e: Error) => {
      // The chat exists (CREATE succeeded); only the title lookup failed.
      this.log(`openDirectChat: room metadata unavailable: ${toKakaoError(e).code}`);
      return null;
    });
    const title = meta?.title || targetName || 'DirectChat';
    return { chatId, title, isNew: true, friend };
  }

  async getChatInfo(chatId: string, refresh = false): Promise<ChannelMeta> {
    const meta = await this.chats.getInfo(chatId, refresh);
    return { ...meta, raw: {} };
  }

  /** The account's own memo chat (나와의 채팅), decided only by the server's MemoChat type code. */
  isMemoChat(chatId: string): boolean {
    return this.chats?.get(chatId)?.type === 'MemoChat';
  }

  getRoomAccess(chatId: string) {
    const trust = this.config.agentMode === 'trust';
    return { chatId, rule: this.roomAccess.rule(chatId), defaultMode: trust || this.isMemoChat(chatId) ? 'immediate' as const : 'deny' as const,
      unreadRestriction: trust ? 'none' as const : 'confirmed-read-only' as const, readReceipts: trust ? 'agent-mode-trust' as const : 'separate-approval' as const };
  }

  setRoomAccess(chatId: string, rule: unknown) {
    return { chatId, rule: this.roomAccess.set(chatId, rule) };
  }

  /** Only from a human-approved read_room operation. */
  createReadGrant(grant: { grantId: string; chatId: string; tools: ReadGrantTool[]; maxMessages: number; uses: number; expiresAt: number }) {
    return this.roomAccess.createReadGrant(grant);
  }
  listReadGrants() { return this.roomAccess.listReadGrants(); }
  /** Rooms whose content rule is not deny (no message contents). */
  listRoomAccess() { return this.roomAccess.listRules(); }
  revokeReadGrant(grantId: string) { return this.roomAccess.revokeReadGrant(grantId); }

  /**
   * Called after this account left a room, by any path. Permissions approved for that membership must not
   * revive on a rejoin, so core withdraws its room rule and read grants and then tells listeners (the send
   * permission lives in the agent journal). A failure is logged, never thrown into the push handler.
   */
  onChatLeft(listener: (chatId: string, reason: LeftReason) => void): void { this.leftListeners.push(listener); }
  private chatLeft(chatId: string, reason: LeftReason): void {
    if (!/^[1-9]\d{0,18}$/.test(chatId)) return;
    this.chats.remove(chatId);
    try {
      const r = this.roomAccess.forgetRoom(chatId, reason);
      if (r.rule || r.readGrants) this.log(`left room (${reason}): withdrew read rule=${r.rule} readGrants=${r.readGrants}`);
    } catch (e) { this.log(`ERROR left room (${reason}): could not withdraw read permissions: ${toKakaoError(e).code}`); }
    for (const listener of this.leftListeners) {
      try { listener(chatId, reason); }
      catch (e) { this.log(`ERROR left room (${reason}): listener failed: ${toKakaoError(e).code}`); }
    }
  }

  /** Narrowing only; broadening from an agent goes through the approved operation engine. */
  tightenRoomAccess(chatId: string, rule: unknown) {
    return { chatId, rule: this.roomAccess.tighten(chatId, rule) };
  }

  /** Narrowing only: drops the stored rule when the default is no broader, otherwise APPROVAL_REQUIRED. */
  restoreDefaultRoomAccess(chatId: string) {
    return { chatId, ...this.roomAccess.restoreDefault(chatId) };
  }

  /** Only from a human-approved reset_room_access operation. */
  resetRoomAccess(chatId: string) {
    return { chatId, rule: this.roomAccess.reset(chatId) };
  }

  /** The rule this room would have with nothing stored (deny, or immediate for memo chat and trust). */
  defaultRoomAccess(chatId: string) { return this.roomAccess.defaultRule(chatId); }

  /** A single operation owns its budget; rechecks never grant another operation. */
  private async beginContentRead(chatId: string, approval: ReadApproval = {}, count = 1): Promise<() => void> {
    if (this.roomAccess.rule(chatId).unreadPreviewAfterLogId !== undefined) throw new KakaoError('POLICY_DENIED', 'Preview-only approval does not authorize ordinary history, search, polling or media');
    this.roomAccess.take(chatId, approval, count);
    await this.requireReadRoom(chatId);
    const check = () => {
      this.roomAccess.check(chatId, approval, count);
      this.assertRoomStillRead(chatId);
    };
    check();
    return check;
  }

  /** Expiring operator-approved LOCAL preview. No message fetch, room entry or NOTIREAD. */
  async previewUnreadMessages(chatId: string, approval: ReadApproval = {}, limit = 20) {
    this.roomAccess.take(chatId, approval, limit);
    const rule = this.roomAccess.rule(chatId);
    if (rule.unreadPreviewAfterLogId === undefined) throw new KakaoError('POLICY_DENIED', 'This room has no scoped unread preview approval');
    const frozenRule = JSON.stringify(rule);
    const check = () => {
      this.roomAccess.check(chatId, approval, limit);
      if (JSON.stringify(this.roomAccess.rule(chatId)) !== frozenRule) throw new KakaoError('POLICY_DENIED', 'Unread preview approval changed');
    };
    const freshCount = async () => {
      this.requireConnected();
      check();
      const pkt = await this.session.request('LCHATLIST', { chatIds: [], maxIds: [],
        lastTokenId: Long.ZERO, lastChatId: Long.ZERO, lbk: new Int32(0) });
      const status = Number((pkt.data as any)?.status ?? pkt.header.status);
      if (status !== 0) throw locoStatusError('LCHATLIST', status);
      check();
      const room = parseLoginList((pkt.data ?? {}) as Record<string, any>).find(chat => chat.id === chatId);
      if (!Number.isSafeInteger(room?.unreadCount) || room!.unreadCount! < 0) {
        throw new KakaoError('ROOM_NOT_READ', 'Unread preview requires known fresh room metadata');
      }
      return room!.unreadCount!;
    };
    const unreadBefore = await freshCount();
    const after = BigInt(rule.unreadPreviewAfterLogId);
    const messages = this.store.getMessages(chatId, { afterLogId: rule.unreadPreviewAfterLogId, limit })
      .filter(m => /^\d{1,19}$/.test(m.messageId) && BigInt(m.messageId) > after && m.authorId !== this.selfUserId)
      .map(m => ({ messageId: m.messageId, type: m.type, text: m.text, sendAt: m.sendAt }));
    const unreadAfter = await freshCount();
    check();
    return { source: 'local-push-store' as const, messages, unreadBefore, unreadAfter,
      readReceiptSent: false as const, historyFetchSent: false as const };
  }

  async sendMessage(chatId: string, text: string) {
    this.requireConnected();
    const res = await this.session.sendText(chatId, text);
    if (res.status !== 0) throw locoStatusError('WRITE', res.status);
    this.ingestSent(chatId, res, text, 1);
    return res;
  }

  async markRead(chatId: string, watermark: string, confirm = false) {
    this.requireConnected();
    if (confirm !== true) throw new KakaoError('POLICY_DENIED', 'Read receipts require separate operator approval (confirm=true)');
    const res = await this.session.markRead(chatId, watermark);
    if (res.status !== 0) throw locoStatusError('NOTIREAD', res.status);
    // A NOTIREAD acknowledgement is not proof that the account unread count changed.
    // In particular, open chats may still report the old count in LCHATLIST.
    try {
      const readState = await this.inspectRoomReadState(chatId);
      return { ...res, readState };
    } catch (error) {
      // The external action was acknowledged; never turn verification failure into a retry.
      this.log('read receipt acknowledged; server unread verification failed');
      return { ...res, readState: { confirmed: false, reason: 'refresh_failed' as const } };
    }
  }

  async userMarkRead(chatId: string, watermark?: string) {
    this.requireConnected();
    let effectiveWatermark = watermark;
    if (!effectiveWatermark) {
      const messages = this.store.getMessages(chatId, { limit: 1 });
      if (messages.length > 0 && messages[messages.length - 1].messageId) {
        effectiveWatermark = messages[messages.length - 1].messageId;
      }
    }
    if (!effectiveWatermark) {
      effectiveWatermark = this.chats.get(chatId)?.maxLogId;
    }
    if (!effectiveWatermark || effectiveWatermark === '0') {
      return { status: 0, watermark: '0' };
    }
    const res = await this.session.markRead(chatId, effectiveWatermark);
    if (res.status !== 0) throw locoStatusError('NOTIREAD', res.status);
    this.chats.markReadUpTo(chatId, effectiveWatermark);
    return { status: res.status, watermark: effectiveWatermark };
  }

  async sendReply(chatId: string, text: string, reply: { logId: string; userId: string; type?: number; message?: string }) {
    this.requireConnected();
    const res = await this.session.sendReply(chatId, text, reply);
    if (res.status !== 0) throw locoStatusError('WRITE', res.status);
    this.ingestSent(chatId, res, text, 26);
    return res;
  }

  async deleteMessage(chatId: string, logId: string) {
    this.requireConnected();
    const res = await this.session.deleteMessage(chatId, logId);
    if (res.status !== 0) throw locoStatusError('DELETEMSG', res.status);
    this.store.markDeleted(chatId, logId);
    return res;
  }

  async leave(chatId: string, opts: { block?: boolean; silence?: boolean } = {}) {
    this.requireConnected();
    const res = await this.session.leave(chatId, opts);
    if (res.status !== 0) throw locoStatusError('LEAVE', res.status);
    this.chatLeft(chatId, 'leave_chat');
    return res;
  }

  async setMeta(chatId: string, type: number, content: string | Record<string, unknown>) {
    this.requireConnected();
    const res = await this.session.setMeta(chatId, type, content);
    if (res.status !== 0) throw locoStatusError('SETMETA', res.status);
    return res;
  }

  /** LOCO MEMBER: profiles of specific members of a chat (read-only). */
  async getMembers(chatId: string, userIds: string[]) {
    this.requireConnected();
    const res = await this.session.getMembers(chatId, userIds);
    if (res.status !== 0) throw locoStatusError('MEMBER', res.status);
    return { ...res, raw: {} };
  }

  async getMeta(chatId: string, types: number[], approval: ReadApproval = {}) {
    const check = await this.beginContentRead(chatId, approval);
    const result = await this.session.getMeta(chatId, types);
    check();
    return result;
  }

  async forwardMessage(chatId: string, opts: { type?: number; text: string; extra?: string }) {
    this.requireConnected();
    const res = await this.session.forwardMessage(chatId, opts);
    if (res.status !== 0) throw locoStatusError('FORWARD', res.status);
    return res;
  }

  /**
   * "Delete for me": hide messages in the local store only, as KakaoTalk does
   * ("현재 사용중인 기기에서만 삭제됩니다"). LOCO SELFDLMSG is answered with -300. Nothing is sent, so this works offline.
   */
  hideMessages(chatId: string, logIds: string[]) {
    const res = this.store.hideMessages(chatId, logIds);
    this.log(`hide messages hidden=${res.hidden.length} already=${res.alreadyHidden.length} notStored=${res.notStored.length}`);
    return res;
  }

  async sendWithMentions(
    chatId: string,
    text: string,
    mentions: { userId: string; at: number[]; len: number }[]
  ) {
    this.requireConnected();
    const res = await this.session.sendWithMentions(chatId, text, mentions);
    if (res.status !== 0) throw locoStatusError('WRITE', res.status);
    this.ingestSent(chatId, res, text, 1);
    return res;
  }

  /**
   * LOCO SHIP: media-upload allocation / dedup query (step 1 of the media pipeline).
   * Non-destructive — posts no message; it only asks the server whether a file (checksum+size)
   * needs uploading and where (KAGE host/key). Returns the full raw response, including a
   * non-zero status, for the caller to interpret.
   */
  async ship(
    chatId: string,
    opts: { size: number; type: number; checksum: string; ext?: string; extra?: string }
  ) {
    this.requireConnected();
    return this.session.ship(chatId, opts);
  }

  /**
   * Complete media upload pipeline:
   * 1. Query/allocate media via LOCO `SHIP`.
   * 2. Connect to allocated `vh:p` via LocoV2SL, send `POST`, stream encrypted file chunks, and receive `COMPLETE`.
   */
  async uploadMedia(
    chatId: string,
    opts: {
      data: Uint8Array;
      type: number;
      fileName?: string;
      width?: number;
      height?: number;
      ext?: string;
      extra?: string;
      timeoutMs?: number;
      commitReuse?: boolean;
    }
  ) {
    this.requireConnected();
    const res = await this.session.uploadMedia(chatId, {
      userId: this.selfUserId,
      ...opts
    });
    const log = res.chatLog;
    if (res.status === 0 && log?.logId) {
      this.ingest({
        chatId: String(log.chatId || chatId),
        authorId: this.selfUserId,
        messageId: String(log.logId),
        type: log.type ?? opts.type,
        text: log.message ?? '',
        attachment: log.attachment,
        sendAt: log.sendAt || Math.floor(Date.now() / 1000),
        raw: res.raw
      });
    }
    return res;
  }

  /** Human adapter only: server byte reuse still needs POST/COMPLETE publication. */
  async uploadUserMedia(chatId: string, opts: { data: Uint8Array; type: number; fileName?: string; width?: number; height?: number; timeoutMs?: number }) {
    if (!this.chats.get(chatId)) throw new KakaoError('NOT_FOUND', 'Account room not found');
    if (![2, 18].includes(opts.type) || !opts.data.length || opts.data.length > 16 * 1024 * 1024) throw new KakaoError('INVALID_ARGUMENT', 'Unsupported human media upload');
    return this.uploadMedia(chatId, { ...opts, commitReuse: true });
  }

  /** One approved photo bundle; upload items first, then publish exactly one message. ✅ two JPEGs/self-chat. */
  async uploadMultiPhotos(chatId: string, data: readonly Uint8Array[], beforeStep?: () => void) {
    this.requireConnected();
    if (!/^\d{1,19}$/.test(chatId) || BigInt(chatId) > 9223372036854775807n) {
      throw new KakaoError('INVALID_ARGUMENT', 'Photo bundle requires an exact decimal chat ID');
    }
    const items = preparePhotoBundle(data);
    const result = await this.session.uploadMultiPhotos(chatId, { userId: this.selfUserId, items, beforeStep });
    // Preserve the exact attachment sent even if WRITE's acknowledgement omits its chatLog.
    if (result.status === 0 && result.logId) this.ingestSent(chatId, { ...result,
      raw: { ...result.raw, chatLog: { ...result.raw.chatLog, attachment: result.raw.chatLog?.attachment ?? result.extra } } }, '', 27);
    return { status: result.status, logId: result.logId, photoCount: result.photoCount };
  }

  /**
   * LOCO GETTRAILER: resolve download host/port for a media token.
   */
  async getTrailer(token: string, type = 2) {
    throw new KakaoError('POLICY_DENIED', 'Unscoped media lookup is blocked; use download_media with an authorized chat');
  }

  /**
   * Complete media download pipeline:
   * 1. Query download trailer host/port via LOCO `GETTRAILER`.
   * 2. Connect to allocated `vh:p` via LocoV2SL, send `DOWN` (or `MINI`),
   *    and receive streamed raw media bytes.
   */
  async downloadMedia(
    chatId: string,
    opts: {
      token: string;
      messageId?: string;
      type?: number;
      offset?: number;
      isMini?: boolean;
      width?: number;
      height?: number;
      timeoutMs?: number;
      confirmRead?: boolean; readGrant?: ReadGrantRef;
    }
  ) {
    const check = await this.beginContentRead(chatId, opts);
    const message = opts.messageId ? this.store.getMessage(chatId, opts.messageId) : undefined;
    if (!message || this.store.hiddenIds([message.messageId]).size || this.store.deletedIds([message.messageId]).size) {
      throw new KakaoError('POLICY_DENIED', 'Media must refer to a visible stored message in the authorized room');
    }
    let attachment: Record<string, unknown>;
    try { attachment = JSON.parse(message.attachment ?? '{}'); }
    catch { throw new KakaoError('INVALID_ARGUMENT', 'Stored media attachment is invalid'); }
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new KakaoError('INVALID_ARGUMENT', 'Stored media attachment is invalid');
    const tokens = [attachment.k, attachment.tk, attachment.tkh, ...(Array.isArray(attachment.kl) ? attachment.kl : [])];
    if (!tokens.includes(opts.token)) throw new KakaoError('POLICY_DENIED', 'Media token does not belong to the selected message');
    const result = await this.session.downloadMedia(chatId, {
      userId: this.selfUserId,
      token: opts.token,
      type: opts.type ?? 2,
      offset: opts.offset,
      isMini: opts.isMini,
      width: opts.width,
      height: opts.height,
      timeoutMs: opts.timeoutMs
    });
    try { check(); return result; }
    catch (error) { result.data.fill(0); throw error; }
  }

  async getHistory(chatId: string, opts: { max?: string; limit?: number; cur?: string; confirmRead?: boolean; readGrant?: ReadGrantRef } = {}) {
    const limit = opts.limit ?? 50;
    const check = await this.beginContentRead(chatId, opts, limit);
    return this.loadHistory(chatId, opts, limit, check, async () => { check(); await this.requireReadRoom(chatId); check(); });
  }

  /** Date range retrieval scans bounded provider pages, then pages the local union.
   * No read receipt, implicit permission change, or promise of pre-device history.
   */
  async getHistoryRange(chatId: string, opts: HistoryRangeOptions & ReadApproval) {
    const range = parseHistoryRange(chatId, opts, this.liveBaseline(chatId)?.toString() ?? '0');
    const check = await this.beginContentRead(chatId, opts, range.limit);
    let state = range.state;
    let sync: Record<string, unknown> = { mode: 'local', truncated: state.truncated };
    if (state.phase === 'sync') {
      const result = await this.loadHistory(chatId, { cur: state.since, max: state.max }, range.limit, check,
        async () => { check(); await this.requireReadRoom(chatId); check(); });
      if (result.sync.error) throw new KakaoError('NETWORK', 'History page could not be fetched; no range result returned');
      if (result.sync.status !== undefined && result.sync.status !== 0 && result.sync.status !== -203) {
        throw locoStatusError('MCHATLOGS', result.sync.status);
      }
      const next = result.sync.nextCur ?? state.since;
      const more = result.sync.hasMore === true;
      const pages = state.pages + result.sync.pages;
      const truncated = more && (pages >= 20 || next === state.since);
      state = { ...state, since: next, pages, truncated, phase: more && !truncated ? 'sync' : 'local' };
      sync = { ...result.sync, truncated };
      if (state.phase === 'sync') {
        check();
        return { chatId, messages: [], nextCursor: historyRangeCursor(state), pending: true, sync,
          coverage: { source: 'available-device-history-and-local-store', completeRequestedPeriod: false,
            reason: 'provider_scan_pending', from: opts.from, to: opts.to } };
      }
    }
    const page = this.store.getRangePage(chatId, { from: range.from, to: range.to, maxLogId: state.max,
      before: state.before, limit: range.limit });
    await this.chats.resolveAuthors(chatId, page.messages.filter(m => !m.authorName).map(m => m.authorId));
    check();
    return { chatId, messages: page.messages.map(m => this.named(m)), pending: false, sync,
      nextCursor: page.next ? historyRangeCursor({ ...state, before: page.next }) : null,
      coverage: { source: 'available-device-history-and-local-store', completeRequestedPeriod: false,
        reason: state.truncated ? 'provider_scan_limit' : 'provider_retention_and_pre_device_history_unknown',
        from: opts.from, to: opts.to, hasMoreLocal: !!page.next,
        returnedFrom: page.messages[0]?.sendAt ?? null, returnedTo: page.messages.at(-1)?.sendAt ?? null } };
  }

  /** Authenticated first-party human UI only. Never expose through an agent adapter.
   * Human history is independent of agent room grants; it sends no NOTIREAD.
   */
  async getUserHistory(chatId: string, opts: { max?: string; limit?: number; cur?: string } = {}) {
    this.requireConnected();
    if (!this.chats.get(chatId)) throw new KakaoError('NOT_FOUND', 'Account room not found');
    const limit = opts.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new KakaoError('INVALID_ARGUMENT', 'Invalid human history limit');
    const check = () => this.requireConnected();
    const result = await this.loadHistory(chatId, opts, limit, check, async () => check());
    if (result.sync.error) throw new KakaoError('NETWORK', 'History request failed');
    if (result.sync.status !== undefined && result.sync.status !== 0 && result.sync.status !== -203) throw locoStatusError('MCHATLOGS', result.sync.status);
    return { ...result, messages: this.annotateMessages(chatId, result.messages) };
  }

  /** Local pages and local search never query other rooms or mutate agent permissions. */
  getUserStoredHistory(chatId: string, before?: string, query?: string) {
    this.requireConnected();
    if (!this.chats.get(chatId)) throw new KakaoError('NOT_FOUND', 'Account room not found');
    if (before !== undefined && (typeof before !== 'string' || !/^[0-9]{1,19}$/.test(before) || BigInt(before) > 9223372036854775807n)) throw new KakaoError('INVALID_ARGUMENT', 'Invalid history boundary');
    if (query !== undefined && (typeof query !== 'string' || !query.trim() || query.length > 200)) throw new KakaoError('INVALID_ARGUMENT', 'Invalid search query');
    const rows = query === undefined ? this.store.getMessages(chatId, { beforeLogId: before, limit: 31 }) : this.store.search(query, { chatId, limit: 31 }).reverse();
    return { hasMore: rows.length > 30, messages: this.annotateMessages(chatId, rows.slice(-30).map(m => this.named(m))) };
  }

  /** Explicit, bounded forward traversal of the provider's available device history. */
  async getUserServerHistory(chatId: string, cursor = '0', max?: string) {
    this.requireConnected();
    const room = this.chats.get(chatId);
    if (!room) throw new KakaoError('NOT_FOUND', 'Account room not found');
    const head = max ?? room.maxLogId;
    if (typeof cursor !== 'string' || typeof head !== 'string' || !/^[0-9]{1,19}$/.test(cursor) || !head || !/^[0-9]{1,19}$/.test(head) || BigInt(head) > 9223372036854775807n || BigInt(cursor) > BigInt(head)) throw new KakaoError('INVALID_ARGUMENT', 'Invalid server history window');
    // Ask the existing connection for a single forward page; never scan automatically.
    const result = await mchatLogsSource(this.session).syncMessages(chatId, { cur: cursor, max: head, count: 30 });
    this.requireConnected();
    if (result.status !== 0 && result.status !== -203) throw locoStatusError('MCHATLOGS', result.status);
    const records = result.messages.filter(m => String(m.chatId) === chatId && m.messageId && BigInt(m.messageId) > BigInt(cursor) && BigInt(m.messageId) <= BigInt(head));
    for (const m of records) this.store.saveReceivedMessage({ ...m, seq: 0, chatId, messageId: String(m.messageId), authorId: String(m.authorId), text: m.text ?? '', attachment: typeof m.attachment === 'string' ? m.attachment : m.attachment ? JSON.stringify(m.attachment) : undefined, sendAt: m.sendAt ?? 0 });
    const next = records.at(-1)?.messageId ?? cursor;
    const hidden = this.store.hiddenIds(records.map(m => String(m.messageId)));
    return { cursor: String(next), max: head, hasMore: result.status === 0 && result.hasMore && BigInt(next) > BigInt(cursor),
      messages: this.annotateMessages(chatId, records.filter(m => !hidden.has(String(m.messageId))).map(m => this.named(this.store.getMessage(chatId, String(m.messageId))!))) };
  }

  /** Local-only human refresh. No network history request, agent grant or read receipt. */
  getUserUpdates(chatId: string, after: string, visibleIds: string[]) {
    this.requireConnected();
    if (!this.chats.get(chatId)) throw new KakaoError('NOT_FOUND', 'Account room not found');
    if (typeof after !== 'string' || !/^[0-9]{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n ||
      !Array.isArray(visibleIds) || visibleIds.length > 200 || visibleIds.some(id => typeof id !== 'string' || !/^[0-9]{1,19}$/.test(id))) {
      throw new KakaoError('INVALID_ARGUMENT', 'Invalid human refresh window');
    }
    const newest = this.store.getMessages(chatId, { afterLogId: after, limit: 201 });
    const reset = newest.length > 200;
    const hidden = this.store.hiddenIds(visibleIds);
    const visible = reset ? [] : visibleIds.flatMap(id => {
      const message = hidden.has(id) ? undefined : this.store.getMessage(chatId, id);
      return message ? [message] : [];
    });
    const rows = [...new Map([...visible, ...newest.slice(-200)].map(m => [m.messageId, m])).values()];
    return { reset, removedIds: visibleIds.filter(id => !visible.some(m => m.messageId === id)), messages: this.annotateMessages(chatId, rows.map(m => this.named(m))) };
  }

  private async loadHistory(chatId: string, opts: { max?: string; cur?: string }, limit: number, check: () => void, beforePage: () => Promise<void>) {
    // Only messages newer than what this daemon already knew are live (feed, unread); older ones are history.
    const baseline = this.liveBaseline(chatId);
    // Backfill from the server (MCHATLOGS, 80 logs a page) when the local store is thin; see history-sync.ts.
    // If opts.max is omitted, backfillHistory checks for newer messages starting from newestStored.
    const sync = await backfillHistory(
      {
        source: mchatLogsSource(this.session),
        beforePage,
        afterPage: check,
        store: this.store,
        decorate: (m) => this.withAuthorName(chatId, m),
        persist: row => baseline !== undefined && /^\d{1,19}$/.test(row.messageId) && BigInt(row.messageId) > baseline
          ? this.inbox.ingest(row).inserted > 0 : this.store.saveReceivedMessage(row),
        onMessage: (row) => {
          const m: IncomingMessage = {
            chatId: row.chatId,
            messageId: row.messageId,
            authorId: row.authorId,
            type: row.type,
            text: row.text,
            attachment: row.attachment,
            sendAt: row.sendAt,
            raw: row.raw ?? {}
          };
          this.noteSynced(m, baseline);
        }
      },
      String(chatId),
      { max: opts.max, limit, pageSize: limit, maxPages: 1, cur: opts.cur }
    );
    this.log(
      `history sync mode=${sync.mode} pages=${sync.pages} ` +
        `status=${sync.status ?? '-'} fetched=${sync.fetched} inserted=${sync.inserted}` +
        (sync.error ? ' error=true' : '')
    );

    const stored = this.store.getMessages(chatId, { limit, beforeLogId: opts.max });
    await this.chats.resolveAuthors(chatId, stored.filter((m) => !m.authorName).map((m) => m.authorId));
    const max = opts.max ?? (stored.length > 0 ? stored[stored.length - 1].messageId : sync.max);
    check();
    return { chatId, max, messages: stored.map((m) => this.named(m)), sync };
  }

  /**
   * The newest logId this daemon already knew for a chat (chat list or store), taken before a sync.
   * Undefined when nothing is known, so a first load of a chat counts as history, not as new messages.
   */
  private liveBaseline(chatId: string): bigint | undefined {
    let best: bigint | undefined;
    for (const id of [this.chats.get(chatId)?.maxLogId, this.store.getNewestLogId(chatId)]) {
      if (!id || !/^\d{1,19}$/.test(id)) continue;
      const n = BigInt(id);
      if (n > 0n && (best === undefined || n > best)) best = n;
    }
    return best;
  }

  /**
   * A message that a sync (not a push) just stored. Only one newer than `baseline` is treated like an
   * incoming push (chat preview, unread count, live feed): backfilling older history must not show up
   * as new messages or inflate unread counts.
   */
  private noteSynced(m: IncomingMessage, baseline: bigint | undefined): void {
    const id = m.messageId != null ? String(m.messageId) : '';
    if (baseline === undefined || !/^\d{1,19}$/.test(id) || BigInt(id) <= baseline) return;
    this.chats.noteMessage(m);
    this.feed.push(this.withAuthorName(String(m.chatId), m));
  }

  async searchMessages(query: string, opts: { chatId?: string; limit?: number; authorId?: string; confirmRead?: boolean; readGrant?: ReadGrantRef } = {}) {
    if (!opts.chatId) throw new KakaoError('POLICY_DENIED', 'Select one room for content search; cross-room search is blocked');
    const check = await this.beginContentRead(opts.chatId, opts, opts.limit ?? 20);
    const result = this.store.search(query, opts).map((m) => this.named(m));
    check();
    return result;
  }

  getUnreadSummary() {
    return this.chats.unreadSummary().map(chat => ({ ...chat, lastMessage: '' }));
  }

  /**
   * Unread counts as the server keeps them for the whole account (chat list field `n`), so chats
   * read on the phone drop to 0. One LCHATLIST round trip; no push tells this device about phone
   * reads (✅ 2026-10-20: opening a chat on the phone sent nothing here).
   */
  async refreshUnread(): Promise<{ updated: number; source: 'server' }> {
    this.requireConnected();
    const pkt = await this.session.request('LCHATLIST', {
      chatIds: [],
      maxIds: [],
      lastTokenId: Long.ZERO,
      lastChatId: Long.ZERO,
      lbk: new Int32(0)
    });
    const status = Number((pkt.data as any)?.status ?? pkt.header.status);
    if (status !== 0) throw locoStatusError('LCHATLIST', status);
    let updated = 0;
    for (const conv of parseLoginList((pkt.data ?? {}) as Record<string, any>)) {
      if (conv.unreadCount != null && this.chats.setUnread(conv.id, conv.unreadCount)) updated++;
    }
    return { updated, source: 'server' };
  }

  /** Messages received after `sinceSeq` (exclusive), optionally filtered to one chat. */
  async recentMessages(sinceSeq = 0, chatId?: string, approval: ReadApproval = {}): Promise<BufferedMessage[]> {
    if (!chatId) throw new KakaoError('POLICY_DENIED', 'Select one room for message polling; cross-room content polling is blocked');
    const check = await this.beginContentRead(chatId, approval);
    const max = this.roomAccess.rule(chatId).maxMessages ?? 50;
    const result = this.withoutHiddenOrDeleted(this.feed.recent(sinceSeq, chatId)).slice(0, max).map(m => this.named(m));
    check();
    return result;
  }

  /** Durable competing-consumer queue. Exact-room authorization precedes selection/limit. */
  async claimMessageEvents(chatId: string, consumer: string, opts: { limit?: number; leaseMs?: number } & ReadApproval = {}) {
    const limit = opts.limit ?? Math.min(50, this.roomAccess.rule(chatId).maxMessages ?? 50);
    const check = await this.beginContentRead(chatId, opts, limit);
    return this.inbox.claim({ chatId, consumer, limit, leaseMs: opts.leaseMs ?? 60000 }, check);
  }

  async ackMessageEvents(input: { sourceGeneration: string; chatId: string; consumer: string; events: Array<{ eventId: string; leaseId: string }> } & ReadApproval) {
    const check = await this.beginContentRead(input.chatId, input);
    return this.inbox.ack(input, check);
  }

  /** Global transport head is metadata, not a durable content-delivery checkpoint. */
  get cursor(): number { return this.feed.cursor; }

  async waitForMessages(sinceSeq: number, timeoutMs: number, chatId?: string, approval: ReadApproval = {}): Promise<BufferedMessage[]> {
    if (!chatId) throw new KakaoError('POLICY_DENIED', 'Select one room for message polling');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new KakaoError('INVALID_ARGUMENT', 'Invalid message wait timeout');
    const check = await this.beginContentRead(chatId, approval);
    const result = await this.feed.wait(sinceSeq, timeoutMs, chatId);
    // A newly received message makes the room unread: never expose it merely
    // because the wait started while the room was read. No second budget slot.
    await this.requireReadRoom(chatId);
    check();
    return this.withoutHiddenOrDeleted(result).slice(0, this.roomAccess.rule(chatId).maxMessages ?? 50).map(m => this.named(m));
  }

  /** Drop feed entries the user hid ("delete for me") or that were deleted ("delete for all"). */
  private withoutHiddenOrDeleted(ms: BufferedMessage[]): BufferedMessage[] {
    const ids = ms.flatMap((m) => (m.messageId ? [String(m.messageId)] : []));
    if (ids.length === 0) return ms;
    const hidden = this.store.hiddenIds(ids);
    const deleted = this.store.deletedIds(ids);
    return ms.filter((m) => {
      if (!m.messageId) return true;
      const id = String(m.messageId);
      if (hidden.has(id) || deleted.has(id)) return false;
      if (m.type != null && (m.type & 16384) !== 0) return false;
      return true;
    });
  }

  // --- block & friend methods ---

  /**
   * Fetch blocked user list and types.
   * The list comes from the address book (type === 9). LOCO BLSYNC is not used: on a live
   * account it never answers (every call waited out the full request timeout), so it stays
   * out until its real response shape is known. Member profiles are resolved via BLMEMBER.
   */
  async getBlockList(opts: { resolveMembers?: boolean } = {}): Promise<{
    revision: number;
    blockIds: string[];
    blockTypes: number[];
    members?: { userId: string; name: string; profileImageUrl?: string }[];
    raw: Record<string, any>;
  }> {
    const blockIds = this.friends.listBlocked().map((b) => b.userId);
    let blockTypes = blockIds.map(() => 1);
    const revision = 0;
    const raw: Record<string, any> = { source: 'friends' };

    let members: { userId: string; name: string; profileImageUrl?: string }[] | undefined;
    if (opts.resolveMembers !== false && blockIds.length > 0) {
      if (this.connected) {
        try {
          const memRes = await this.session.getBlockMembers(blockIds);
          if (memRes.members.length > 0) {
            members = memRes.members;
            if (memRes.blockTypes.length === blockIds.length) blockTypes = memRes.blockTypes;
          }
        } catch (e) {
          this.log(`getBlockList: BLMEMBER failed: ${toKakaoError(e).code}`);
        }
      }
      if (!members || members.length === 0) {
        members = blockIds.map((id) => {
          const f = this.friends.get(id);
          return {
            userId: id,
            name: f ? (f.friendNickName || f.nickName) : id,
            profileImageUrl: f?.profileImageUrl
          };
        });
      }
    }

    return {
      revision,
      blockIds,
      blockTypes,
      members,
      raw
    };
  }

  /**
   * LOCO BLADDITEM: Block a user.
   */
  async blockUser(userId: string | number, blockType: number = 1): Promise<{ status: number; raw: Record<string, any> }> {
    this.requireConnected();
    const uid = String(userId);
    const res = await this.session.addBlockItem([uid], [blockType]);
    if (res.status !== 0) throw locoStatusError('BLADDITEM', res.status);
    this.friends.setBlocked(uid, true);
    return res;
  }

  /**
   * LOCO BLDELITEM: Unblock a user.
   */
  async unblockUser(userId: string | number): Promise<{ status: number; raw: Record<string, any> }> {
    this.requireConnected();
    const uid = String(userId);
    const res = await this.session.deleteBlockItem([uid]);
    if (res.status !== 0) throw locoStatusError('BLDELITEM', res.status);
    this.friends.setBlocked(uid, false);
    return res;
  }

  /**
   * Add a friend by userId via KakaoTalk WAS HTTP API.
   */
  async addFriend(userId: string): Promise<Record<string, any>> {
    return this.friends.add(this.creds.get(), userId);
  }

  /**
   * LOCO MODIFYMSG: edit the text of a message I sent (❓ under live test).
   * The stored copy takes the new text only when the server answers status 0.
   */
  async editMessage(chatId: string, logId: string, text: string): Promise<ModifyMessageResult> {
    this.requireConnected();
    const res = await this.session.modifyMessage(chatId, logId, text);
    if (res.status !== 0) throw locoStatusError('MODIFYMSG', res.status);
    const stored = this.store.getMessage(String(chatId), String(logId));
    if (stored) this.store.saveMessage({ ...stored, text });
    this.log(`edit status=0 echo=${res.modifiedChatLog ? 'modifiedChatLog' : res.chatLog ? 'chatLog' : 'none'}`);
    return res;
  }

  /** Agent-only inspected source/target. Content policy is checked before returning a bounded snapshot. */
  async inspectAgentStoredMessage(chatId: string, logId: string, approval: ReadApproval = {}) {
    const check = await this.beginContentRead(chatId, approval);
    const read = () => {
      const row = this.store.getMessage(chatId, logId);
      if (!row || this.store.hiddenIds([logId]).has(logId) || row.type !== undefined && (row.type & 16384) !== 0) throw new KakaoError('NOT_FOUND', 'Visible local mutation source unavailable');
      return {chatId:row.chatId,messageId:row.messageId,authorId:row.authorId,type:row.type ?? null,text:row.text,attachment:row.attachment ?? null,revision:messageRevision(row)?.toString() ?? null};
    };
    const target = read(), fingerprint = JSON.stringify(target);
    const validate = () => { check(); if (JSON.stringify(read()) !== fingerprint) throw new KakaoError('OPERATION_STALE','Stored mutation source changed'); };
    validate();
    return { target: JSON.parse(JSON.stringify(target)) as typeof target, validate,
      emoticonSupported: target.type !== null && EMOTICON_TYPES.has(target.type) && !!target.attachment && !!parseEmoticonAttachment(target.attachment),
      sendEmoticonTo: async (destination: string) => {
        validate();
        if (target.type === null || !EMOTICON_TYPES.has(target.type) || !target.attachment || !parseEmoticonAttachment(target.attachment)) throw new KakaoError('INVALID_ARGUMENT','Stored source is not a supported emoticon');
        const res = await this.session.sendEmoticonRaw(destination,{type:target.type,extra:target.attachment,text:target.text});
        if (res.status !== 0) throw locoStatusError('WRITE',res.status);
        this.ingestSent(destination,res,target.text,target.type); return {status:res.status,logId:res.logId};
      },
      edit: async (text: string) => { validate(); if (target.authorId !== this.selfUserId) throw new KakaoError('POLICY_DENIED','Only own messages may be edited'); return this.editMessage(chatId,logId,text); },
      delete: async () => { validate(); if (target.authorId !== this.selfUserId) throw new KakaoError('POLICY_DENIED','Only own messages may be deleted'); return this.deleteMessage(chatId,logId); }
    };
  }

  /**
   * Re-send an emoticon that is already in the store. The source must be an emoticon message
   * (type 6, 12, 20, 22 or 25) whose attachment has at least `name` and `path`; type and attachment
   * are sent unchanged (✅ 2026-10-19 with a type 20 emoticon in the memo chat).
   */
  async sendEmoticonFrom(chatId: string, source: { chatId: string; logId: string; confirmRead?: boolean; readGrant?: ReadGrantRef }): Promise<WriteResult> {
    const check = await this.beginContentRead(source.chatId, source);
    check();
    const src = this.store.getMessage(String(source.chatId), String(source.logId));
    if (!src) throw new KakaoError('NOT_FOUND', `message ${source.logId} is not stored for chat ${source.chatId}`);
    const type = Number(src.type);
    if (!EMOTICON_TYPES.has(type)) {
      throw new KakaoError('INVALID_ARGUMENT', `message ${source.logId} is type ${src.type}, not an emoticon (6, 12, 20, 22, 25)`);
    }
    if (!src.attachment || !parseEmoticonAttachment(src.attachment)) {
      throw new KakaoError('INVALID_ARGUMENT', `message ${source.logId} has no emoticon attachment (name, path)`);
    }
    const res = await this.session.sendEmoticonRaw(chatId, { type, extra: src.attachment, text: src.text });
    if (res.status !== 0) throw locoStatusError('WRITE', res.status);
    this.ingestSent(chatId, res, src.text, type);
    return res;
  }

  /**
   * Send an emoticon directly to a chat. Uses LOCO WRITE with type 6, 12, 20, 22 or 25.
   */
  async sendEmoticon(chatId: string, opts: { emoticon: EmoticonAttachment; text?: string; type?: number }): Promise<WriteResult> {
    this.requireConnected();
    const type = opts.type ?? (opts.emoticon.itemType ? getEmoticonType(opts.emoticon.itemType) : 20);
    if (!EMOTICON_TYPES.has(type)) {
      throw new KakaoError('INVALID_ARGUMENT', `invalid emoticon type ${type}`);
    }
    const extra = buildEmoticonExtra(opts.emoticon);
    const text = opts.text ?? opts.emoticon.name ?? '(이모티콘)';
    const res = await this.session.sendEmoticonRaw(chatId, { type, extra, text });
    if (res.status !== 0) throw locoStatusError('WRITE', res.status);
    this.ingestSent(chatId, res, text, type);
    return res;
  }

  /**
   * Search users on KakaoTalk WAS HTTP API by query.
   */
  async searchUserRemote(query: string): Promise<Record<string, any>> {
    return this.friends.searchRemote(this.creds.get(), query);
  }

  /**
   * Get detailed profile for a profileId (or main profile if omitted) and multi-profiles list via WAS HTTP API.
   */
  async getMyProfile(profileId?: string): Promise<MyProfileResult> {
    return this.profile.getMyProfile(this.creds.get(), profileId);
  }

  /**
   * Update profile information via WAS HTTP API POST /mac/profile/update.json.
   */
  async updateMyProfile(profileId: string, params: { statusMessage?: string; nickname?: string }): Promise<Record<string, any>> {
    return this.profile.updateProfile(this.creds.get(), profileId, params);
  }

  /**
   * List all user profiles (including multi-profiles) via WAS HTTP API.
   */
  async listMyProfiles(): Promise<KakaoProfileSummary[]> {
    return this.profile.listProfiles(this.creds.get());
  }

  /**
   * Get friend's detailed profile via WAS HTTP API.
   */
  async getFriendProfile(userId: string): Promise<KakaoFriendProfile> {
    return this.profile.getFriendProfile(this.creds.get(), userId);
  }

  stop(): void {
    this.session.close();
  }

  // -- internals -------------------------------------------------------------

  /**
   * In ask mode, content is accessible only in an explicitly read room. trust lifts this: the operator chose
   * to let the AI read rooms with unread messages. Reading never changes read state in either mode.
   */
  private readStateRestricted(): boolean { return this.config.agentMode !== 'trust'; }

  /** Content is accessible only in an explicitly read room (ask mode). Never changes read state. */
  private assertRoomStillRead(chatId: string): void {
    if (!this.readStateRestricted()) return;
    const count = this.chats.get(chatId)?.unreadCount;
    if (count !== 0) {
      throw new KakaoError('ROOM_NOT_READ', 'Content access requires a confirmed already-read room; unread or unknown rooms are blocked',
        { details: { reason: Number.isSafeInteger(count) && count! > 0 ? 'local_unread' : 'unread_unknown' } });
    }
  }

  /** Metadata only. Never interprets a local read-receipt ACK as authoritative unread0. */
  async inspectRoomReadState(chatId: string) {
    this.requireConnected();
    const before = this.chats.get(chatId);
    if (!before) throw new KakaoError('NOT_FOUND', 'Exact room is not in the local chat list');
    const localUnreadCount = before.unreadCount;
    const head = before.maxLogId;
    const pkt = await this.session.request('LCHATLIST', { chatIds: [], maxIds: [],
      lastTokenId: Long.ZERO, lastChatId: Long.ZERO, lbk: new Int32(0) });
    const status = Number((pkt.data as any)?.status ?? pkt.header.status);
    if (status !== 0) throw locoStatusError('LCHATLIST', status);
    const room = parseLoginList((pkt.data ?? {}) as Record<string, any>).find(chat => chat.id === chatId);
    let count = room?.unreadCount;
    let present = !!room;
    let source: 'chat_info' | 'chat_info_watermark' | undefined;
    let verification: { countValid: boolean; countProvided: boolean; countValidityKnown: boolean; countMarkedInvalid: boolean;
      watermarkKnown: boolean; watermarkCoversHead: boolean; serverHeadCoversLocal: boolean; accountSeenCoversServer: boolean } | undefined;
    if (!room) {
      // A room learned from a push can be absent from the session's list snapshot.
      // Ask for its exact metadata; absence never implies an unread count of zero.
      const detail = await this.session.request('CHATINFO', { chatId: Long.fromString(chatId) });
      const detailStatus = Number((detail.data as any)?.status ?? detail.header.status);
      if (detailStatus !== 0) throw locoStatusError('CHATINFO', detailStatus);
      const info = (detail.data as any)?.chatInfo;
      present = !!info && String(info.chatId) === chatId && info.left !== true;
      count = present && info.invalidNewMessageCount === false ? info.newMessageCount : undefined;
      source = 'chat_info';
      const logId = (value: unknown): bigint | undefined => {
        if (!(typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) || Long.isLong(value))) return;
        const text = String(value);
        return /^(0|[1-9]\d{0,18})$/.test(text) ? BigInt(text) : undefined;
      };
      const latest = present ? logId(info.lastLogId) : undefined;
      const seen = present ? logId(info.lastSeenLogId) : undefined;
      const localHead = logId(head);
      const countValid = Number.isSafeInteger(count) && count! >= 0;
      const watermarkKnown = latest !== undefined && seen !== undefined && localHead !== undefined;
      const watermarkCoversHead = watermarkKnown && latest! >= localHead! && seen! >= latest!;
      verification = { countValid, countProvided: info?.newMessageCount !== undefined,
        countValidityKnown: typeof info?.invalidNewMessageCount === 'boolean', countMarkedInvalid: info?.invalidNewMessageCount === true,
        watermarkKnown, watermarkCoversHead, serverHeadCoversLocal: latest !== undefined && localHead !== undefined && latest >= localHead,
        accountSeenCoversServer: latest !== undefined && seen !== undefined && seen >= latest };
      // This is the account's own server read position, not another member's
      // DECUNREAD notification or an acknowledgement of our mark-read request.
      if (!countValid && watermarkCoversHead) { count = 0; source = 'chat_info_watermark'; }
    }
    const known = Number.isSafeInteger(count) && count! >= 0;
    const current = this.chats.get(chatId);
    // Do not overwrite a message push or another metadata update during the request.
    const unchanged = current?.maxLogId === head && current?.unreadCount === localUnreadCount;
    if (known && unchanged) this.chats.setUnread(chatId, count!);
    const reason = !present ? 'room_missing' : !known ? 'unread_unknown' : count !== 0 ? 'server_unread' :
      !unchanged ? 'local_state_changed' : 'confirmed_read';
    return { confirmed: reason === 'confirmed_read', reason, localUnreadCount,
      serverUnreadCount: known ? count! : null, ...(source ? { source, verification } : {}) };
  }

  private async requireReadRoom(chatId: string): Promise<void> {
    this.requireConnected();
    if (!this.readStateRestricted()) return;
    this.assertRoomStillRead(chatId);
    const state = await this.inspectRoomReadState(chatId);
    if (!state.confirmed) throw new KakaoError('ROOM_NOT_READ',
      'Server unread state is not confirmed zero; read-receipt acknowledgement alone is insufficient',
      { details: { ...state, nextAction: 'Open this exact room in the official app, then refresh unread metadata; do not repeat mark_read automatically' } });
    this.assertRoomStillRead(chatId);
  }

  /** Human account media: resolve only visible stored originals, never caller URLs. */
  async getUserMedia(chatId: string, messageId: string) {
    this.requireConnected();
    if (!this.chats.get(chatId)) throw new KakaoError('NOT_FOUND', 'Account room not found');
    const message = this.store.getMessage(chatId, messageId);
    if (!message || this.store.hiddenIds([messageId]).size || this.store.deletedIds([messageId]).size ||
        ((message.type ?? 0) & 16384) !== 0 || ![2, 3, 5, 18].includes(message.type ?? 0)) throw new KakaoError('NOT_FOUND', 'Visible stored media not found');
    let attachment: Record<string, unknown>;
    try { attachment = JSON.parse(message.attachment ?? '{}') as Record<string, unknown>; }
    catch { throw new KakaoError('INVALID_ARGUMENT', 'Invalid stored attachment'); }
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new KakaoError('INVALID_ARGUMENT', 'Invalid stored attachment');
    const size = attachment.s ?? attachment.size;
    if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 16 * 1024 * 1024) throw new KakaoError('NOT_IMPLEMENTED', 'Media requires saved size up to 16 MiB');
    const source = typeof message.raw?.source === 'string' ? this.mediaSources.get(message.raw.source) : undefined;
    let result;
    if (source) result = await source(message);
    else {
      const token = message.type === 3 ? attachment.tk ?? attachment.k : attachment.k;
      if (typeof token !== 'string' || !token || token.length > 4096) throw new KakaoError('NOT_IMPLEMENTED', 'Stored media token unavailable');
      result = await this.session.downloadMedia(chatId, { userId: this.selfUserId, token, type: message.type!, timeoutMs: 15000, maxBytes: 16 * 1024 * 1024 });
    }
    const bytes = Buffer.from(result.data);
    if (result.status !== 0 || bytes.length !== size || result.size !== size) { bytes.fill(0); throw new KakaoError('NOT_FOUND', 'Original media size mismatch'); }
    return { data: bytes, size: bytes.length };
  }

  /** Media sources of optional modules, by the `raw.source` their restored messages carry. */
  private readonly mediaSources = new Map<string, (message: StoredMessage) => Promise<{ status: number; data: Uint8Array; size: number }>>();

  /**
   * In-process hooks for trusted optional modules, never reachable through MCP. Every
   * content read still goes through room access and the read-state check here; a module only adds a source.
   */
  extensionHost() {
    return {
      config: this.config, db: this.db, store: this.store,
      credentials: () => this.creds.get(),
      /** Room rule, budget and read state before content work; returns the re-check to run after it. */
      beginContentRead: (chatId: string, approval: ReadApproval = {}, count = 1) => this.beginContentRead(chatId, approval, count),
      /** The same checks without spending budget, for re-checks right before a local commit. */
      checkContentRead: (chatId: string, approval: ReadApproval = {}, count = 1) => {
        this.roomAccess.check(chatId, approval, count); this.assertRoomStillRead(chatId);
      },
      knownChatIds: () => this.chats.list().map(chat => chat.id),
      getChatInfo: (chatId: string) => this.getChatInfo(chatId),
      rememberExisting: (meta: ChannelMeta) => this.chats.rememberExisting(meta),
      /** One bounded re-login for an HTTP 401, updating the existing session; never a second LOCO connection. */
      reloginForHttp: async () => {
        const c = this.creds.get();
        if (!c.email || !c.password) throw new KakaoError('AUTH_EXPIRED', 'HTTP authentication expired; configured re-login credentials are unavailable');
        const result = await this.refreshAuth({ status: -950, accessToken: c.accessToken, deviceUUID: c.deviceUUID });
        if (!result) throw new KakaoError('AUTH_EXPIRED', 'Configured bounded re-login stopped; operator review required');
        this.session.updateCredentials({ accessToken: result.accessToken });
      },
      registerMediaSource: (source: string, download: (message: StoredMessage) => Promise<{ status: number; data: Uint8Array; size: number }>) => {
        this.mediaSources.set(source, download);
      }
    };
  }

  async exportChatHistory(chatId: string, opts: { format: 'json' | 'html'; title?: string; limit?: number } & ReadApproval) {
    const grantMax = opts.readGrant?.id ? this.roomAccess.readGrant(opts.readGrant.id)?.maxMessages : undefined;
    const ruleMax = this.roomAccess.rule(chatId).maxMessages ?? 50;
    const defaultLimit = Math.min(grantMax ?? ruleMax, ruleMax);
    const limit = opts.limit ?? defaultLimit;
    const check = await this.beginContentRead(chatId, opts, limit);
    const visible = this.store.getMessages(chatId, { limit }).map(m => this.named(m));
    const res = this.vault.exportChatHistory(chatId, visible.map(m => ({
      messageId: m.messageId,
      chatId: m.chatId,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      type: m.type ?? 1,
      sendAt: m.sendAt
    })), opts);
    check();
    return res;
  }

  async collectSharedLinks(chatId: string, opts: { limit?: number } & ReadApproval) {
    const grantMax = opts.readGrant?.id ? this.roomAccess.readGrant(opts.readGrant.id)?.maxMessages : undefined;
    const ruleMax = this.roomAccess.rule(chatId).maxMessages ?? 50;
    const defaultLimit = Math.min(grantMax ?? ruleMax, ruleMax);
    const limit = opts.limit ?? defaultLimit;
    const check = await this.beginContentRead(chatId, opts, limit);
    const visible = this.store.getMessages(chatId, { limit }).map(m => this.named(m));
    const res = collectSharedLinks(visible.map(m => ({
      messageId: m.messageId,
      chatId: m.chatId,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      sendAt: m.sendAt
    })));
    check();
    return res;
  }

  async extractScheduleAndTodos(chatId: string, opts: { limit?: number } & ReadApproval) {
    const grantMax = opts.readGrant?.id ? this.roomAccess.readGrant(opts.readGrant.id)?.maxMessages : undefined;
    const ruleMax = this.roomAccess.rule(chatId).maxMessages ?? 50;
    const defaultLimit = Math.min(grantMax ?? ruleMax, ruleMax);
    const limit = opts.limit ?? defaultLimit;
    const check = await this.beginContentRead(chatId, opts, limit);
    const visible = this.store.getMessages(chatId, { limit }).map(m => this.named(m));
    const res = extractScheduleAndTodos(visible.map(m => ({
      messageId: m.messageId,
      chatId: m.chatId,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      sendAt: m.sendAt
    })));
    check();
    return res;
  }

  async searchVault(opts: { chatIds: string[]; query: string; limit?: number } & ReadApproval) {
    if (!Array.isArray(opts.chatIds) || opts.chatIds.length === 0) {
      throw new KakaoError('INVALID_ARGUMENT', 'Select at least one room for vault search');
    }
    const query = String(opts.query ?? '').trim();
    if (!query) throw new KakaoError('INVALID_ARGUMENT', '"query" is required');
    const grantMax = opts.readGrant?.id ? this.roomAccess.readGrant(opts.readGrant.id)?.maxMessages : undefined;
    const defaultLimit = Math.min(grantMax ?? 20, 20);
    const limitPerRoom = opts.limit ?? defaultLimit;

    if (new Set(opts.chatIds).size !== opts.chatIds.length) throw new KakaoError('INVALID_ARGUMENT', 'List each room once');

    // 1. Authorize all rooms first: if even one fails, the whole call is rejected immediately.
    // Check every room without spending budget or grant uses, so a refusal on a later room
    // leaves the earlier rooms' read budgets untouched; only then reserve them.
    for (const chatId of opts.chatIds) {
      if (this.roomAccess.rule(chatId).unreadPreviewAfterLogId !== undefined) {
        throw new KakaoError('POLICY_DENIED', 'Preview-only approval does not authorize ordinary history, search, polling or media');
      }
      this.roomAccess.check(chatId, opts, limitPerRoom, true);
    }
    const checks: Array<() => void> = [];
    for (const chatId of opts.chatIds) {
      const check = await this.beginContentRead(chatId, opts, limitPerRoom);
      checks.push(check);
    }

    // 2. Perform search across all authorized rooms
    const allResults = [];
    for (const chatId of opts.chatIds) {
      const results = this.store.search(query, { chatId, limit: limitPerRoom }).map(m => this.named(m));
      allResults.push(...results);
    }

    // 3. Post-execution checks
    for (const check of checks) {
      check();
    }

    return {
      query,
      count: allResults.length,
      searchedRooms: opts.chatIds.length,
      messages: allResults
    };
  }

  getVaultStats() {
    return this.vault.getStats();
  }

  /** One inbound or self-sent message: feed it to pollers, persist it, update its chat. */
  private ingest(m: IncomingMessage): void {
    const observed = this.withAuthorName(m.chatId, m);
    const buffered = { ...observed, seq: this.feed.cursor + 1 };
    if (buffered.messageId) {
      this.inbox.ingest({
        seq: buffered.seq,
        chatId: String(buffered.chatId),
        messageId: String(buffered.messageId),
        authorId: String(buffered.authorId || ''),
        authorName: buffered.authorName,
        type: buffered.type,
        text: buffered.text || '',
        attachment:
          buffered.attachment == null || typeof buffered.attachment === 'string'
            ? buffered.attachment
            : JSON.stringify(buffered.attachment, longReplacer),
        sendAt: buffered.sendAt || Math.floor(Date.now() / 1000),
        raw: buffered.raw
      });
    }
    // Wake transient pollers only after message, queue reference and checkpoint commit.
    this.feed.push(observed);
    if (this.config.vaultAutoSave && buffered.messageId && buffered.attachment && [2, 3, 5, 18, 27].includes(buffered.type ?? 0)) {
      void this.vault.autoSaveMessageMedia(
        String(buffered.chatId),
        String(buffered.messageId),
        buffered.type ?? 2,
        buffered.attachment,
        async (token, mediaType, sink) => {
          return this.session.downloadMedia(String(buffered.chatId), {
            userId: this.selfUserId,
            token,
            type: mediaType,
            // Archived videos can be large: fail only when the transfer stalls, not after a fixed total time.
            idleTimeoutMs: 30000,
            sink
          });
        }
      ).catch(() => this.log('[vault] auto-save media download failed'));
    }
    if (!buffered.authorName && buffered.authorId) {
      // Large groups do not list every member; look the author up so later reads carry the name.
      void this.chats.resolveAuthors(String(m.chatId), [String(buffered.authorId)]);
    }
    if (this.chats.noteMessage(m)) {
      // First sight of this chat (not in LOGINLIST): resolve its type/title.
      const newId = String(m.chatId);
      void this.chats.getInfo(newId).catch((e: Error) =>
        this.log(`new room metadata unavailable (shown untitled): ${toKakaoError(e).code}`)
      );
    }
    if (m.authorId && String(m.authorId) !== this.selfUserId && m.messageId) {
      this.noteReaderWatermark(String(m.chatId), String(m.authorId), String(m.messageId));
    }
    this.log('message received');
  }

  /**
   * Record a message we just sent. The server's WRITE response echoes the stored chatLog
   * (e.g. type 26 + quote attachment for a reply); prefer it over what we asked for.
   */
  private ingestSent(chatId: string, res: { logId?: string; raw?: Record<string, any> }, text: string, fallbackType: number): void {
    if (!res.logId) return;
    const echo = res.raw?.chatLog as Record<string, any> | undefined;
    this.ingest({
      chatId: String(chatId),
      authorId: this.selfUserId,
      messageId: res.logId,
      type: typeof echo?.type === 'number' ? echo.type : fallbackType,
      text: typeof echo?.message === 'string' ? echo.message : text,
      attachment: echo?.attachment ?? undefined,
      sendAt: typeof echo?.sendAt === 'number' ? echo.sendAt : Math.floor(Date.now() / 1000),
      raw: res.raw ?? {}
    });
  }

  /** Fill in an author name that was unknown when the message was stored or buffered. */
  private named<T extends { chatId: string | number; authorId?: string | number; authorName?: string; authorProfileUrl?: string }>(m: T): T {
    if (!m.authorId) return m;
    const authorName = m.authorName || this.chats.authorName(String(m.chatId), String(m.authorId));
    const authorProfileUrl = m.authorProfileUrl || this.chats.authorProfileUrl(String(m.chatId), String(m.authorId));
    return { ...m, ...(authorName ? { authorName } : {}), ...(authorProfileUrl ? { authorProfileUrl } : {}) };
  }

  noteReaderWatermark(chatId: string, userId: string, watermark: string): void {
    if (!chatId || !watermark || !/^\d+$/.test(watermark)) return;
    if (userId && userId === this.selfUserId) return;
    const current = this.readerWatermarks.get(chatId);
    if (!current || BigInt(watermark) > BigInt(current)) {
      this.readerWatermarks.set(chatId, watermark);
    }
  }

  getReaderWatermark(chatId: string): bigint {
    let best = 0n;
    const recorded = this.readerWatermarks.get(chatId);
    if (recorded && /^\d+$/.test(recorded)) {
      best = BigInt(recorded);
    }
    const cleanSelf = this.selfUserId.replace(/\.0$/, '');
    const fromStore = this.store.getNewestLogIdFromOther(chatId, cleanSelf);
    if (fromStore && /^\d+$/.test(fromStore)) {
      const n = BigInt(fromStore);
      if (n > best) best = n;
    }
    return best;
  }

  annotateMessages<T extends { chatId: string | number; messageId?: string | number; authorId?: string | number }>(chatId: string, messages: T[]): (T & { unread?: number })[] {
    const chat = this.chats.get(chatId);
    if (chat?.type === 'MemoChat') {
      return messages.map(m => ({ ...m, unread: 0 }));
    }
    const cleanSelf = this.selfUserId.replace(/\.0$/, '');
    const readerWatermark = this.getReaderWatermark(chatId);
    const isGroup = Boolean(chat ? chat.isGroup : false);
    const memberCount = chat?.memberCount;
    const groupCount = isGroup && memberCount && memberCount > 2 ? Math.max(1, memberCount - 1) : 1;
    return messages.map(m => {
      if (!m.messageId) return { ...m, unread: 0 };
      const rawAuthor = m.authorId != null ? String(m.authorId).replace(/\.0$/, '') : '';
      const isFromSelf = Boolean(rawAuthor && rawAuthor === cleanSelf);
      if (!isFromSelf && !isGroup) {
        return { ...m, unread: 0 };
      }
      const msgId = BigInt(m.messageId);
      if (readerWatermark > 0n && msgId <= readerWatermark) {
        return { ...m, unread: 0 };
      }
      return { ...m, unread: isGroup ? groupCount : 1 };
    });
  }

  private withAuthorName(chatId: string, m: IncomingMessage): IncomingMessage & { authorName?: string } {
    return { ...m, authorName: this.chats.authorName(chatId, m.authorId) };
  }

  private log(line: string): void {
    if (this.logSink) { this.logSink(line); return; }
    process.stderr.write(`[kakao] ${line}\n`);
  }
}
