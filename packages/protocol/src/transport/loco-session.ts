import { uploadPhotoBundle, type PhotoUploadItem } from './multi-photo.js';
import { uploadPhotoItemToTrailer } from './multi-photo-trailer.js';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BSON } from 'bson';
import { encodeLocoPacket, decodeLocoPacket, LOCO_HEADER_SIZE, LocoPacket } from '../framing/loco-packet.js';
import { createLocoV2Handshake, encryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { drainLocoFrames, locoBodyLength, ConversationItem, LoginListResult, LocoClient, BookingResult } from './loco-client.js';
import {
  parseChatLog,
  parseLoginList,
  parseReadReceipt,
  parseChannelMeta,
  parseSyncResult,
  parseMember,
  parseOpenLink,
  buildEmoticonExtra,
  getEmoticonType,
  EmoticonAttachment,
  OpenLinkItem,
  MultiPhotoItem
} from './loco-parse.js';
import { LocoError } from '../errors/loco-error.js';
import {
  uploadMediaToTrailer,
  downloadMediaFromTrailer,
  TrailerUploadResult,
  TrailerUploadOptions,
  TrailerDownloadResult,
  TrailerDownloadOptions,
  TrailerChunkSink
} from './trailer-client.js';

export interface LocoSessionOptions {
  appVersion?: string;
  os?: string;
  /** Send a LOCO PING every N ms to keep the carriage connection alive (0 = disabled). */
  pingIntervalMs?: number;
  /**
   * Consecutive failed PINGs after which the link is treated as dead and the socket is dropped,
   * so the reconnect path runs instead of waiting for TCP to give up (default 2; 0 = never).
   */
  maxMissedPings?: number;
  /** TCP keepalive initial delay in ms once connected (default 30000; 0 = disabled). */
  tcpKeepAliveMs?: number;
  /** Per-request response timeout. */
  requestTimeoutMs?: number;
  /**
   * TCP connect + login deadline. A short value fails fast when CHECKIN allocates an
   * unreachable chat server, so a caller can retry another allocation. The idle timeout is
   * DISABLED once the session is established (PING keepalive handles liveness instead), so a
   * short value here does not drop an idle listening session.
   */
  connectTimeoutMs?: number;
  /**
   * Observe every decoded LOCO packet (requests we send and packets we receive). Used to
   * record sanitized fixtures for replay tests; must not throw or block.
   */
  onFrame?: (frame: LocoFrame) => void;
}

/** One decoded LOCO packet as seen by `onFrame`. */
export interface LocoFrame {
  direction: 'out' | 'in';
  id: number;
  method: string;
  status: number;
  /** For 'in': true when it answers one of our requests (false = server push). */
  response?: boolean;
  body: Record<string, unknown>;
}

export interface IncomingMessage {
  chatId: string;
  authorId?: string;
  messageId?: string;
  type?: number;
  text?: string;
  sendAt?: number;
  attachment?: string | Record<string, any>;
  raw: Record<string, any>;
}

export interface WriteResult {
  status: number;
  messageId?: string;
  logId?: string;
  raw: Record<string, any>;
}

/** Options for a text WRITE. */
export interface WriteOptions {
  /** The client message ID (positive 31-bit integer) the server echoes in the chat log; random when omitted. */
  msgId?: number;
}

function clientMsgId(opts: WriteOptions): number {
  if (opts.msgId === undefined) return Math.floor(Math.random() * 0x7fffffff);
  if (!Number.isInteger(opts.msgId) || opts.msgId < 1 || opts.msgId > 0x7fffffff) {
    throw new LocoError('INVALID_ARGUMENT', 'msgId must be a positive 31-bit integer', { command: 'WRITE' });
  }
  return opts.msgId;
}

/**
 * KakaoTalk media message types (the `type`/`logType` on a media WRITE/POST and on stored chat
 * logs). These are the commonly used LOCO values; confirm a number against the server before
 * relying on a type this project has not exercised.
 */
export const MediaType = {
  Photo: 2,
  Video: 3,
  Audio: 5,
  File: 18,
  MultiPhoto: 27
} as const;
export type MediaTypeValue = (typeof MediaType)[keyof typeof MediaType];

/**
 * Shared-room `SETMETA`/`GETMETA` metadata types. Only `Notice` is relied on; the rest are the
 * commonly used LOCO values and must be confirmed against the server before use. Per-user
 * pin/mute/favorite are NOT in this set.
 */
export const ChatMetaType = {
  Notice: 1,
  Group: 2,
  Title: 3,
  Profile: 4,
  Tv: 5,
  Privilege: 6,
  TvLive: 7,
  PlusBackground: 8,
  LiveTalkInfo: 11,
  LiveTalkCount: 12,
  OpenChannelChat: 13
} as const;
export type ChatMetaTypeValue = (typeof ChatMetaType)[keyof typeof ChatMetaType];

/** One `@` mention span: which user, and where in the text they're referenced. */
export interface MentionSpan {
  userId: string | number;
  /** character offsets in the message text where the @name appears. */
  at: number[];
  /** length of the @name token. */
  len: number;
}

/** The message being quoted in a reply (답장). */
export interface ReplyTarget {
  /** logId of the quoted message (→ src_logId). */
  logId: string | number;
  /** userId of the quoted message's author (→ src_userId). */
  userId: string | number;
  /** type of the quoted message (→ src_type / attach_type); defaults to 1 (text). */
  type?: number;
  /** text snippet of the quoted message (→ src_message). */
  message?: string;
  mentions?: unknown[];
}

export interface ReadReceipt {
  chatId: string;
  /** The participant who read (absent in some payloads). */
  userId?: string;
  /** The log id up to which messages were read. */
  watermark?: string;
  raw: Record<string, any>;
}

export interface ChannelMember {
  userId: string;
  name: string;
  profileImageUrl?: string;
}

/** KakaoTalk block types. 1 = message block, 2 = message + profile block */
export const BlockType = {
  Message: 1,
  MessageAndProfile: 2
} as const;
export type BlockTypeValue = (typeof BlockType)[keyof typeof BlockType];

export interface BlockSyncResult {
  status: number;
  revision: number;
  isFull?: boolean;
  blockIds: string[];
  blockTypes: number[];
  unblockIds?: string[];
  plusRevision?: number;
  plusIsFull?: boolean;
  plusBlockIds?: string[];
  plusBlockTypes?: number[];
  plusUnblockIds?: string[];
  raw: Record<string, any>;
}

export interface BlockMemberResult {
  status: number;
  members: ChannelMember[];
  blockTypes: number[];
  plusMembers?: ChannelMember[];
  plusBlockTypes?: number[];
  raw: Record<string, any>;
}

export interface ModifyMessageResult {
  status: number;
  chatLog?: IncomingMessage;
  modifiedChatLog?: IncomingMessage;
  raw: Record<string, any>;
}

export interface SyncLinkResult {
  status: number;
  openLinks: OpenLinkItem[];
  deletedLinkIds: string[];
  lastLinkToken: number;
  raw: Record<string, any>;
}

export interface MultiPhotoShipResult {
  status: number;
  tokenList: string[];
  portList: number[];
  v2slHostList: string[];
  v2slHost6List: string[];
  mimeTypeList: string[];
  raw: Record<string, any>;
}

export interface ChannelMeta {
  chatId: string;
  title: string;
  /** Whether title came from room metadata or is a member-name fallback. */
  titleSource?: 'custom' | 'shared' | 'open_chat' | 'participants';
  isGroup: boolean;
  /** CHATINFO `chatInfo.type` (DirectChat, MultiChat, MemoChat, OM, OD, ...) when the server sent it. */
  type?: string;
  members: ChannelMember[];
  /** The channel's current last log id (from CHATINFO) — use as `max` for history sync. */
  lastLogId?: string;
  raw: Record<string, any>;
}

export interface SyncResult {
  status: number;
  messages: IncomingMessage[];
  /** True when the server indicates more logs remain to page through. */
  hasMore: boolean;
  raw: Record<string, any>;
}

type Pending = { method: string; resolve: (p: LocoPacket) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * A persistent, authenticated LOCO carriage session (Phase 3).
 *
 * Unlike the one-shot request/response calls in LocoClient, this keeps the chat-server
 * socket open: it runs a receive loop that reassembles LocoV2SL GCM frames into a LOCO
 * packet stream, routes responses back to their request by packetId, and emits server
 * pushes (`MSG`, etc.) as events. Supports sending text (`WRITE`) and receiving live
 * messages (`MSG`).
 *
 * Events:
 *   'message' (IncomingMessage) — a received chat message (LOCO `MSG` push)
 *   'packet'  (LocoPacket)      — any unsolicited server push
 *   'close'   ()                — connection closed
 *   'error'   (Error)
 */
export class LocoSession extends EventEmitter {
  private socket?: net.Socket;
  private aesKey?: Uint8Array;
  private incoming = Buffer.alloc(0);
  private plain = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pingTimer?: NodeJS.Timeout;
  private missedPings = 0;
  private closed = false;

  private readonly appVersion: string;
  private readonly os: string;
  private readonly pingIntervalMs: number;
  private readonly maxMissedPings: number;
  private readonly tcpKeepAliveMs: number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onFrame?: (frame: LocoFrame) => void;

  constructor(opts: LocoSessionOptions = {}) {
    super();
    this.appVersion = opts.appVersion ?? '26.4.0';
    this.os = opts.os ?? 'mac';
    this.pingIntervalMs = opts.pingIntervalMs ?? 0;
    this.maxMissedPings = opts.maxMissedPings ?? 2;
    this.tcpKeepAliveMs = opts.tcpKeepAliveMs ?? 30000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8000;
    this.onFrame = opts.onFrame;
  }

  private tap(frame: LocoFrame): void {
    if (!this.onFrame) return;
    try {
      this.onFrame(frame);
    } catch {
      // A broken observer must never take the session down.
    }
  }

  /**
   * Connect to the allocated carriage server, perform the LocoV2SL handshake, send
   * LOGINLIST, and keep the socket open. Resolves with the conversation list.
   */
  connect(
    chatHost: string,
    chatPort: number,
    userId: string | number,
    accessToken: string,
    deviceUUID: string
  ): Promise<LoginListResult> {
    return new Promise((resolve, reject) => {
      // Short idle timeout during connect/login = fast-fail on an unreachable allocation.
      const socket = net.connect({ host: chatHost, port: chatPort, timeout: this.connectTimeoutMs }, () => {
        if (this.tcpKeepAliveMs > 0) socket.setKeepAlive(true, this.tcpKeepAliveMs);
        const { handshakeBytes, aesKey } = createLocoV2Handshake();
        this.aesKey = aesKey;
        socket.write(Buffer.from(handshakeBytes));

        const loginReq = {
          appVer: this.appVersion,
          prtVer: '1',
          os: this.os,
          lang: 'ko',
          duuid: deviceUUID,
          oauthToken: accessToken,
          dtype: 2,
          ntype: 0,
          MCCMNC: '999',
          revision: 0,
          chatIds: [],
          maxIds: [],
          lastTokenId: BSON.Long.ZERO,
          lbk: 0,
          bg: false
        };

        this.request('LOGINLIST', loginReq)
          .then((pkt) => {
            socket.setTimeout(0); // session established — rely on PING keepalive, not idle timeout
            const res = pkt.data as Record<string, any>;
            const conversations: ConversationItem[] = parseLoginList(res);
            resolve({
              status: Number(res.status ?? pkt.header.status),
              revision: Number(res.revision || 0),
              conversations,
              raw: res
            });
          })
          .catch(reject);

        if (this.pingIntervalMs > 0) {
          this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
        }
      });

      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => { this.reportError(err); if (this.pending.size === 0) reject(err); });
      socket.on('timeout', () => socket.destroy(new LocoError('TIMEOUT', 'carriage socket timed out')));
      socket.on('close', () => this.handleClose());
      this.socket = socket;
    });
  }

  /**
   * Send a text message to a conversation (LOCO `WRITE`, type 1). `msgId` is the client's own message
   * ID, echoed in the room's chat log; pass a stable one to find this send in history later.
   */
  async sendText(chatId: string | number, text: string, opts: WriteOptions = {}): Promise<WriteResult> {
    const body = {
      chatId: typeof chatId === 'number' ? BSON.Long.fromNumber(chatId) : BSON.Long.fromString(String(chatId)),
      msg: text,
      type: 1,
      noSeen: false,
      msgId: clientMsgId(opts),
      extra: ''
    };
    const pkt = await this.request('WRITE', body);
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Fetch message history for a chat via LOCO `SYNCMSG` — returns logs newer than `cur`
   * (0 = from the beginning the server will serve), up to `count`, bounded by `max` (0 = latest).
   */
  async syncMessages(
    chatId: string | number,
    opts: { cur?: string | number; max?: string | number; count?: number } = {}
  ): Promise<SyncResult> {
    const { cur = 0, max = 0, count = 30 } = opts;
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('SYNCMSG', {
      chatId: toLong(chatId),
      cur: toLong(cur),
      cnt: count,
      max: toLong(max)
    });
    return parseSyncResult(pkt.data as Record<string, any>, pkt.header.status);
  }

  /**
   * Fetch logs after `since` for each chat via LOCO `MCHATLOGS` (`{chatIds, sinces}` →
   * `{chatLogs, eof}`, up to 80 logs per call, oldest first). Pass the last returned logId as the
   * next `since`; `eof` marks the end. The server only serves logs from after this device key was
   * registered, whatever `since` is.
   */
  async chatLogs(
    chatIds: (string | number)[],
    sinces: (string | number)[]
  ): Promise<SyncResult & { eof: boolean }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('MCHATLOGS', { chatIds: chatIds.map(toLong), sinces: sinces.map(toLong) });
    const res = pkt.data as Record<string, any>;
    return { ...parseSyncResult(res, pkt.header.status), eof: res.eof === true };
  }

  /**
   * Page through a chat's history with repeated `SYNCMSG` calls, advancing `cur` by the
   * server's `lastTokenId` (or the last returned logId) until the `(cur, max]` range is
   * exhausted, the server reports no more, or `maxPages` is hit. Returns logs in order.
   */
  async syncAllMessages(
    chatId: string | number,
    opts: { max: string | number; pageSize?: number; maxPages?: number }
  ): Promise<IncomingMessage[]> {
    const { max, pageSize = 50, maxPages = 20 } = opts;
    const out: IncomingMessage[] = [];
    let cur: string | number = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.syncMessages(chatId, { cur, max, count: pageSize });
      if (res.status !== 0 || res.messages.length === 0) break;
      out.push(...res.messages);
      const nextCur = res.raw.lastTokenId != null
        ? String(res.raw.lastTokenId)
        : res.messages[res.messages.length - 1].messageId;
      if (!nextCur || nextCur === String(cur)) break; // no forward progress
      cur = nextCur;
      if (!res.hasMore) break;
    }
    return out;
  }

  /**
   * Resolve a channel's human metadata: group title (from `CHATINFO` `chatInfo.mcMetas.name`)
   * and member display names + avatars (from `GETMEM`). For a 1:1 chat the title is the other
   * member's name; for a group without a name, the members' names joined.
   */
  async getChannelMeta(chatId: string | number, selfUserId?: string | number): Promise<ChannelMeta> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const [mem, info] = await Promise.all([
      this.request('GETMEM', { chatId: toLong(chatId) }).catch(() => null),
      this.request('CHATINFO', { chatId: toLong(chatId) }).catch(() => null)
    ]);
    const meta = parseChannelMeta(chatId, mem?.data as Record<string, any> | undefined, info?.data as Record<string, any> | undefined, selfUserId);
    const room = (info?.data as Record<string, any> | undefined)?.chatInfo;
    // Resolve only this room's existing link. INFOLINK is metadata-only; no join,
    // read receipt, link search, or unrelated link enumeration is performed.
    const linkId = room?.li != null ? String(room.li) : '';
    if (meta.titleSource === 'participants' && (room?.type === 'OM' || room?.type === 'OD') && /^[1-9]\d{0,18}$/.test(linkId)) {
      const packet = await this.request('INFOLINK', { lis: [toLong(linkId)] });
      const data = packet.data as Record<string, any>;
      const status = Number(data.status ?? packet.header.status);
      if (status !== 0) throw new LocoError('STATUS', `INFOLINK failed with status ${status}`);
      const links = Array.isArray(data.ols) ? data.ols : [];
      const link = links.find((item: any) => String(item.li ?? item.linkId) === linkId);
      const name = link?.ln ?? link?.linkName;
      if (typeof name === 'string' && name.trim()) {
        meta.title = name;
        meta.titleSource = 'open_chat';
      }
    }
    return meta;
  }

  /**
   * LOCO MEMBER: profiles of specific members of a chat, by userId. Read-only. Request
   * `{chatId, memberIds}`, response `{chatId, members}`. GETMEM does not list every member of a
   * large chat; this resolves the ones we need (e.g. message authors) by id.
   */
  async getMembers(chatId: string | number, memberIds: (string | number)[]): Promise<{ status: number; members: ChannelMember[]; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('MEMBER', { chatId: toLong(chatId), memberIds: memberIds.map(toLong) });
    const res = pkt.data as Record<string, any>;
    const members = Array.isArray(res.members) ? res.members.map(parseMember) : [];
    return { status: Number(res.status ?? pkt.header.status), members, raw: res };
  }

  /**
   * Mark a chat read up to `watermark` (the last read log id) via LOCO `NOTIREAD`.
   * An ACK does not prove the account unread count changed; verify fresh metadata separately.
   */
  async markRead(chatId: string | number, watermark: string | number): Promise<{ status: number }> {
    const body = {
      chatId: typeof chatId === 'number' ? BSON.Long.fromNumber(chatId) : BSON.Long.fromString(String(chatId)),
      watermark: typeof watermark === 'number' ? BSON.Long.fromNumber(watermark) : BSON.Long.fromString(String(watermark))
    };
    const pkt = await this.request('NOTIREAD', body);
    return { status: Number((pkt.data as Record<string, any>)?.status ?? pkt.header.status) };
  }

  /**
   * Delete a sent message for everyone via LOCO `DELETEMSG` `{chatId, logId}`.
   * Delete-for-everyone has a server-side time window (~5 min) and is irreversible — the caller
   * is responsible for confirming intent.
   */
  async deleteMessage(chatId: string | number, logId: string | number): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('DELETEMSG', { chatId: toLong(chatId), logId: toLong(logId) });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * Send a text message that quotes an earlier one (답장). Encoded as a type-26 `WRITE`
   * whose `extra` carries the reply attachment. Type must be 26 (type 1 renders as plain text
   * in KakaoTalk), and the attachment contains { src_linkId: 0, src_userId, src_logId, src_type, src_message }.
   */
  async sendReply(chatId: string | number, text: string, reply: ReplyTarget, opts: WriteOptions = {}): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const srcUserId = typeof reply.userId === 'string' ? Number(reply.userId) : reply.userId;
    const srcLogId = String(reply.logId);
    const srcType = Number(reply.type ?? 1);
    const srcMsg = JSON.stringify(reply.message ?? '');
    // Construct JSON string directly to preserve 64-bit integer precision for src_logId
    const extra = `{"src_linkId":0,"src_userId":${srcUserId},"src_logId":${srcLogId},"src_type":${srcType},"src_message":${srcMsg}}`;
    const body = {
      chatId: toLong(chatId),
      msg: text,
      type: 26,
      noSeen: false,
      msgId: clientMsgId(opts),
      extra
    };
    const pkt = await this.request('WRITE', body);
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Create or resolve a chat room with one or more member userIds (LOCO `CREATE`).
   * For 1:1 chat, if a direct chat room already exists with the given member,
   * the server returns the existing chatId and chatRoom metadata instead of duplicating.
   */
  async createChat(
    memberIds: (string | number)[],
    opts: { pushAlert?: boolean; memoChat?: boolean; nickName?: string } = {}
  ): Promise<{ status: number; chatId?: string; chatRoom?: Record<string, any>; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const body: Record<string, any> = {
      memberIds: memberIds.map(toLong),
      pushAlert: opts.pushAlert ?? true,
      memoChat: opts.memoChat ?? false
    };
    if (opts.nickName) body.nickName = opts.nickName;
    const pkt = await this.request('CREATE', body);
    const res = pkt.data as Record<string, any>;
    const rawChatId = res.chatId ?? res.c;
    return {
      status: Number(res.status ?? pkt.header.status),
      chatId: rawChatId != null ? String(rawChatId) : undefined,
      chatRoom: res.chatRoom ?? res.chatLog,
      raw: res
    };
  }

  /**
   * Enter a chat room (LOCO `CHATONROOM`). Fetches room state and updates read token.
   */
  async chatOnRoom(chatId: string | number, token: string | number = 0): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('CHATONROOM', {
      chatId: toLong(chatId),
      token: toLong(token),
      opt: 0
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      raw: res
    };
  }

  /**
   * Step 1 of the media-send pipeline: LOCO `SHIP` asks the server whether a file (identified by
   * its `checksum` + `size`) needs uploading, and where. The response carries the KAGE upload
   * host/key or a dedup hit.
   */
  async ship(
    chatId: string | number,
    opts: { size: number; type: number; checksum: string; ext?: string; extra?: string }
  ): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('SHIP', {
      c: toLong(chatId),
      t: opts.type,
      s: BSON.Long.fromNumber(opts.size),
      cs: opts.checksum,
      e: opts.ext ?? '',
      ...(opts.extra != null ? { ex: opts.extra } : {})
    });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * Step 3 of the media-send pipeline: after the file bytes are uploaded to KAGE and an upload
   * `token` is obtained, LOCO `POST` posts the media message into the chat.
   * Full 18-field body: { mm, c, ns, av, mid, silence, s, nt, f, t, u, h, sp, os, w, k, scp, ex }.
   */
  async sendMediaPost(opts: {
    chatId: string | number;
    userId: string | number;
    token: string;
    type: number;
    size: number;
    fileName?: string;
    width?: number;
    height?: number;
    extra?: string;
  }): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('POST', {
      mm: '999',
      c: toLong(opts.chatId),
      ns: false,
      av: '26.4.0',
      mid: Math.floor(Math.random() * 0x7fffffff),
      silence: false,
      s: BSON.Long.fromNumber(opts.size),
      nt: 0,
      f: opts.fileName ?? '',
      t: opts.type,
      u: toLong(opts.userId),
      h: opts.height ?? 0,
      sp: '',
      os: 'mac',
      w: opts.width ?? 0,
      k: opts.token,
      scp: 1,
      ex: opts.extra ?? ''
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Complete media upload pipeline:
   * 1. Query/allocate media via LOCO `SHIP`.
   * 2. If deduplicated (`rd: true`), the file exists on the server.
   * 3. Otherwise, connect to allocated `vh:p` via LocoV2SL, send `POST`,
   *    stream encrypted file chunks, and receive `COMPLETE`.
   */
  async uploadMedia(
    chatId: string | number,
    opts: {
      userId: string | number;
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
  ): Promise<TrailerUploadResult> {
    const checksum = crypto.createHash('sha1').update(opts.data).digest('hex');

    const shipRes = await this.ship(chatId, {
      size: opts.data.length,
      type: opts.type,
      checksum,
      ext: opts.ext ?? opts.fileName?.split('.').pop() ?? '',
      extra: opts.extra
    });

    if (shipRes.status !== 0) {
      throw new LocoError('STATUS', `SHIP failed with status ${shipRes.status}`, { command: 'SHIP', status: shipRes.status });
    }

    const { vh, p, k, rd } = shipRes.raw;
    if (rd && opts.commitReuse !== true) {
      return {
        status: 0,
        chatLog: {
          logId: '',
          chatId: String(chatId),
          type: opts.type,
          authorId: String(opts.userId),
          message: opts.type === 2 ? '사진' : '파일',
          sendAt: Math.floor(Date.now() / 1000),
          attachment: JSON.stringify({ k })
        },
        raw: shipRes.raw
      };
    }

    let host = vh, port = p;
    if (rd && opts.commitReuse === true && (!host || !port)) {
      if (typeof k !== 'string' || !k || k.length > 4096) throw new LocoError('MALFORMED', 'Reused upload token unavailable', { command: 'SHIP' });
      const location = await this.getTrailer(k, opts.type);
      if (location.status !== 0) throw new LocoError('STATUS', 'Reused upload location unavailable', { command: 'GETTRAILER', status: location.status });
      host = location.raw.vh; port = location.raw.p;
    }
    if (!host || !port || !k) {
      throw new LocoError('MALFORMED', 'Invalid SHIP response: missing vh, p, or k', { command: 'SHIP' });
    }

    return uploadMediaToTrailer({
      host,
      port: Number(port),
      token: k,
      userId: opts.userId,
      chatId,
      data: opts.data,
      type: opts.type,
      fileName: opts.fileName,
      width: opts.width,
      height: opts.height,
      extra: opts.extra,
      appVersion: this.appVersion,
      os: this.os,
      timeoutMs: opts.timeoutMs
    });
  }

  /**
   * Media download: LOCO `GETTRAILER` resolves a stored media `token` (from a Photo/Video/File
   * chat log) to its downloadable location. Request `{k: token, t: type}`.
   */
  async getTrailer(token: string, type: number): Promise<{ status: number; raw: Record<string, any> }> {
    const pkt = await this.request('GETTRAILER', { k: token, t: type });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * Complete media download pipeline:
   * 1. Query download trailer host/port via LOCO `GETTRAILER`.
   * 2. Connect to allocated `vh:p` via LocoV2SL, send `DOWN` (or `MINI`),
   *    and stream-decrypt raw media bytes.
   */
  async downloadMedia(
    chatId: string | number,
    opts: {
      userId: string | number;
      token: string;
      type: number;
      maxBytes?: number;
      offset?: number;
      isMini?: boolean;
      width?: number;
      height?: number;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      sink?: TrailerChunkSink;
    }
  ): Promise<TrailerDownloadResult> {
    const trailerRes = await this.getTrailer(opts.token, opts.type);
    if (trailerRes.status !== 0) {
      throw new LocoError('STATUS', `GETTRAILER failed with status ${trailerRes.status}`, { command: 'GETTRAILER', status: trailerRes.status });
    }

    const { vh, p } = trailerRes.raw;
    if (!vh || !p) {
      throw new LocoError('MALFORMED', 'Invalid GETTRAILER response: missing vh or p', { command: 'GETTRAILER' });
    }

    return downloadMediaFromTrailer({
      host: vh,
      port: Number(p),
      token: opts.token,
      userId: opts.userId,
      chatId,
      offset: opts.offset,
      isMini: opts.isMini,
      width: opts.width,
      height: opts.height,
      appVersion: this.appVersion,
      os: this.os,
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxBytes: opts.maxBytes,
      sink: opts.sink
    });
  }

  /**
   * Forward a message's content to another chat (LOCO `FORWARD`).
   * Body: { chatId, msgId, type, noSeen, extra, msg }.
   * ❓ Status -203, untested hypothesis: `FORWARD` is for server-stored media and needs that
   * media's trailer metadata in `extra`; forwarded plain text goes as an ordinary `WRITE` (type 1).
   */
  async forwardMessage(
    chatId: string | number,
    opts: { type?: number; text: string; extra?: string }
  ): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('FORWARD', {
      chatId: toLong(chatId),
      msgId: Math.floor(Math.random() * 0x7fffffff),
      type: opts.type ?? 1,
      noSeen: false,
      extra: opts.extra ?? '',
      msg: opts.text
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Send a text message with `@` mentions (LOCO `WRITE` type 1 with a `mentions` attachment).
   * Each span is `{ user_id, at: [charIndex…], len }`. The exact encoding (`mentions` array of
   * `{at,len,user_id}`, `all_mention` for @전체) is best-effort and not yet verified against the
   * server — a wrong encoding renders as a plain message (non-destructive).
   */
  async sendWithMentions(chatId: string | number, text: string, mentions: MentionSpan[], opts: WriteOptions = {}): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    // user_id is written as a bare JSON integer (it can exceed 2^53, so it is not passed through
    // Number). That makes validation the only thing between an agent-supplied string and the JSON.
    const isIndex = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    const mentionItems = mentions.map((m) => {
      const userId = String(m.userId);
      const at = Array.isArray(m.at) ? m.at : [m.at];
      if (!/^\d{1,19}$/.test(userId)) {
        throw new LocoError('INVALID_ARGUMENT', `mention userId must be a numeric id, got ${JSON.stringify(userId).slice(0, 40)}`, { command: 'WRITE' });
      }
      if (at.length === 0 || !at.every(isIndex) || !isIndex(m.len) || m.len === 0) {
        throw new LocoError('INVALID_ARGUMENT', 'mention at must be non-negative integer indexes and len a positive integer', { command: 'WRITE' });
      }
      return `{"at":${JSON.stringify(at)},"len":${m.len},"user_id":${userId}}`;
    });
    const extra = `{"mentions":[${mentionItems.join(',')}]}`;
    const pkt = await this.request('WRITE', {
      chatId: toLong(chatId),
      msg: text,
      type: 1,
      noSeen: false,
      msgId: clientMsgId(opts),
      extra
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Leave a chat room via LOCO `LEAVE` `{chatId, block, silence}`: `block` also blocks the room/inviter; `silence` = 조용히 나가기 (no leave feed to the others).
   * Irreversible — the caller confirms intent.
   */
  async leave(
    chatId: string | number,
    opts: { block?: boolean; silence?: boolean } = {}
  ): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('LEAVE', {
      chatId: toLong(chatId),
      block: opts.block ?? false,
      silence: opts.silence ?? false
    });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * Set **shared/room-wide** metadata via LOCO `SETMETA`. `type` is a numeric
   * `ChatMetaType` (see below); `content` is a JSON string the server broadcasts to all members
   * (e.g. the Notice/title). **Per-user settings (pin / mute / favorite) do NOT go here** — those
   * are client/per-user and stay local. The exact `type` numbers are not yet verified.
   */
  async setMeta(
    chatId: string | number,
    type: number,
    content: string | Record<string, unknown>
  ): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('SETMETA', {
      chatId: toLong(chatId),
      type: Number(type),
      content: typeof content === 'string' ? content : JSON.stringify(content)
    });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * Read shared room metadata via LOCO `GETMETA`. `types` is a list of `ChatMetaType` numbers.
   */
  async getMeta(chatId: string | number, types: number[]): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('GETMETA', { chatId: toLong(chatId), types: types.map(Number) });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /** Send a LOCO packet and resolve with the response that echoes its packetId. */
  request(method: string, body: Record<string, unknown>): Promise<LocoPacket> {
    if (this.closed || !this.socket || !this.aesKey) return Promise.reject(new LocoError('NOT_CONNECTED', 'session not connected'));
    const id = this.nextId++;
    this.tap({ direction: 'out', id, method, status: 0, body });
    const frame = encryptLocoV2Frame(encodeLocoPacket(id, 0, method, body), this.aesKey);
    return new Promise<LocoPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new LocoError('TIMEOUT', `${method} (id ${id}) timed out`, { command: method }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket!.write(Buffer.from(frame));
    });
  }

  close(): void {
    this.handleClose();
    this.socket?.end();
  }

  /** Abruptly drop the underlying socket (no FIN) to simulate a network drop — for testing reconnect. */
  forceDrop(): void {
    this.socket?.destroy(new Error('forced drop (test)'));
  }

  /**
   * One keepalive PING. A reply resets the miss count; `maxMissedPings` failures in a row mean the
   * link is silently dead, so the session closes now (pending requests reject, later ones fail with
   * NOT_CONNECTED) and the socket is dropped, instead of hanging until TCP gives up.
   */
  private ping(): void {
    this.request('PING', {}).then(
      () => { this.missedPings = 0; },
      () => {
        if (this.closed) return;
        this.missedPings++;
        if (this.maxMissedPings > 0 && this.missedPings >= this.maxMissedPings) {
          const socket = this.socket;
          this.handleClose();
          socket?.destroy();
        }
      }
    );
  }

  /**
   * Report a session error to listeners. Until the session is wired (during connect and login) nobody
   * listens, and an unheard 'error' would throw and end the process; the failure already reaches the
   * caller through the connect promise or the request. A listener that throws is contained too.
   */
  private reportError(err: Error): void {
    if (this.listenerCount('error') === 0) return;
    try {
      this.emit('error', err);
    } catch {
      // An 'error' listener that throws must not take the session down either.
    }
  }

  /** True once the connection has closed (clean or dropped). */
  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    const { plaintext, consumed } = drainLocoFrames(this.incoming, this.aesKey!);
    if (consumed > 0) {
      this.incoming = this.incoming.subarray(consumed);
      this.plain = Buffer.concat([this.plain, plaintext]);
    }
    // Parse every complete LOCO packet in the plaintext stream.
    for (;;) {
      const bodyLen = locoBodyLength(this.plain);
      if (bodyLen === null || this.plain.length < LOCO_HEADER_SIZE + bodyLen) break;
      const packetBytes = this.plain.subarray(0, LOCO_HEADER_SIZE + bodyLen);
      this.plain = this.plain.subarray(LOCO_HEADER_SIZE + bodyLen);
      let decoded: LocoPacket;
      try {
        decoded = decodeLocoPacket(packetBytes);
      } catch (err) {
        this.reportError(err as Error);
        continue;
      }
      // A listener that throws (e.g. a storage failure while recording a message) must neither
      // crash the process nor strand the packets still buffered behind this one.
      try {
        this.dispatch(decoded);
      } catch (err) {
        this.reportError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private dispatch(pkt: LocoPacket): void {
    const waiter = this.pending.get(pkt.header.id);
    this.tap({
      direction: 'in',
      id: pkt.header.id,
      method: pkt.header.method,
      status: pkt.header.status,
      response: Boolean(waiter && pkt.header.id !== 0),
      body: pkt.data as Record<string, unknown>
    });
    if (waiter && pkt.header.id !== 0) {
      this.pending.delete(pkt.header.id);
      clearTimeout(waiter.timer);
      waiter.resolve(pkt);
      return;
    }
    // Unsolicited push.
    this.emit('packet', pkt);
    const d = pkt.data as Record<string, any>;
    if (pkt.header.method === 'MSG') {
      this.emit('message', parseChatLog(d.chatLog ?? d, d));
    } else if (pkt.header.method === 'DECUNREAD') {
      // A participant read messages up to `watermark` in `chatId` — i.e. a read receipt.
      this.emit('read', parseReadReceipt(d));
    } else {
      this.dispatchLaneBPush(pkt.header.method, d);
    }
  }

  // --- block list ---

  /**
   * LOCO BLSYNC: Synchronize blocked user IDs and block types.
   * BSON keys: r (revision), pr (plusRevision).
   * ❓ Unverified: on a live account the server never answers this request (it times out),
   * so nothing calls it yet.
   */
  async syncBlockList(opts: { revision?: number; plusRevision?: number } = {}): Promise<BlockSyncResult> {
    const pkt = await this.request('BLSYNC', {
      r: Number(opts.revision ?? 0),
      pr: Number(opts.plusRevision ?? 0)
    });
    const res = pkt.data as Record<string, any>;
    const toIdStr = (arr: any) => (Array.isArray(arr) ? arr.map((x) => String(x)) : []);
    const toNumArr = (arr: any) => (Array.isArray(arr) ? arr.map((x) => Number(x)) : []);
    return {
      status: Number(res.status ?? pkt.header.status),
      revision: Number(res.r ?? res.revision ?? 0),
      isFull: res.f ?? res.isFull,
      blockIds: toIdStr(res.l ?? res.blockIds),
      blockTypes: toNumArr(res.ts ?? res.blockTypes),
      unblockIds: toIdStr(res.dl ?? res.unblockIds),
      plusRevision: res.pr != null ? Number(res.pr) : undefined,
      plusIsFull: res.pf ?? res.plusIsFull,
      plusBlockIds: res.pl ? toIdStr(res.pl) : undefined,
      plusBlockTypes: res.pts ? toNumArr(res.pts) : undefined,
      plusUnblockIds: res.pdl ? toIdStr(res.pdl) : undefined,
      raw: res
    };
  }

  /**
   * LOCO BLMEMBER: Query profiles of blocked users by id.
   * BSON keys: l (blockIds), pl (plusBlockIds).
   */
  async getBlockMembers(
    blockIds: (string | number)[],
    plusBlockIds: (string | number)[] = []
  ): Promise<BlockMemberResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('BLMEMBER', {
      l: blockIds.map(toLong),
      pl: plusBlockIds.map(toLong)
    });
    const res = pkt.data as Record<string, any>;
    const rawMembers = Array.isArray(res.l ?? res.members) ? (res.l ?? res.members) : [];
    const rawPlusMembers = Array.isArray(res.pl ?? res.plusMembers) ? (res.pl ?? res.plusMembers) : [];
    const toNumArr = (arr: any) => (Array.isArray(arr) ? arr.map((x) => Number(x)) : []);
    return {
      status: Number(res.status ?? pkt.header.status),
      members: rawMembers.map(parseMember),
      blockTypes: toNumArr(res.ts ?? res.blockTypes),
      plusMembers: rawPlusMembers.map(parseMember),
      plusBlockTypes: toNumArr(res.pts ?? res.plusBlockTypes),
      raw: res
    };
  }

  /**
   * LOCO BLADDITEM: Block users.
   * BSON keys: l (blockIds), ts (blockTypes), fr (friendshipArray).
   */
  async addBlockItem(
    userIds: (string | number)[],
    blockTypes: number[] = [1]
  ): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('BLADDITEM', {
      l: userIds.map(toLong),
      ts: blockTypes.map(Number),
      fr: userIds.map(() => 0)
    });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  /**
   * LOCO BLDELITEM: Unblock users.
   * BSON keys: l (unblockIds), pl (plusUnblockIds).
   */
  async deleteBlockItem(userIds: (string | number)[]): Promise<{ status: number; raw: Record<string, any> }> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('BLDELITEM', {
      l: userIds.map(toLong)
    });
    const res = pkt.data as Record<string, any>;
    return { status: Number(res.status ?? pkt.header.status), raw: res };
  }

  // --- queued protocols (unverified live) ---
  // Nothing in core or MCP calls these yet; write paths must go through SendPolicy when wired up.

  /**
   * Modify a previously sent message (LOCO `MODIFYMSG` { chatId, logId, type, msg, extra }).
   */
  async modifyMessage(
    chatId: string | number,
    logId: string | number,
    text: string,
    opts: { type?: number; extra?: string } = {}
  ): Promise<ModifyMessageResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('MODIFYMSG', {
      chatId: toLong(chatId),
      logId: toLong(logId),
      type: opts.type ?? 1,
      msg: text,
      extra: opts.extra ?? ''
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      chatLog: res.chatLog ? parseChatLog(res.chatLog, res) : undefined,
      modifiedChatLog: res.modifiedChatLog ? parseChatLog(res.modifiedChatLog, res) : undefined,
      raw: res
    };
  }

  /**
   * Send an emoticon message (LOCO `WRITE` with type 6/12/20/22/25).
   * Unverified live.
   */
  async sendEmoticon(
    chatId: string | number,
    opts: { emoticon: EmoticonAttachment; text?: string; type?: number }
  ): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    // Live attachments carry no itemType, so the caller may pass the message type instead.
    const type = opts.type ?? (opts.emoticon.itemType ? getEmoticonType(opts.emoticon.itemType) : undefined);
    if (type === undefined) throw new LocoError('INVALID_ARGUMENT', 'emoticon needs a message type or an itemType', { command: 'WRITE' });
    const extra = buildEmoticonExtra(opts.emoticon);
    const text = opts.text ?? opts.emoticon.name;
    const pkt = await this.request('WRITE', {
      chatId: toLong(chatId),
      msg: text,
      type,
      noSeen: false,
      msgId: Math.floor(Math.random() * 0x7fffffff),
      extra
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Send an emoticon WRITE with a ready-made attachment, as received in another message.
   * ✅ 2026-10-19: a type 20 emoticon re-sent this way to the memo chat. Real attachments look like
   * `{ alt, emoticonItemPath, kid, name, path }` (no `itemType`), so passing them through unchanged
   * is safer than rebuilding them with buildEmoticonExtra.
   */
  async sendEmoticonRaw(chatId: string | number, opts: { type: number; extra: string; text?: string }): Promise<WriteResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('WRITE', {
      chatId: toLong(chatId),
      msg: opts.text ?? '',
      type: opts.type,
      noSeen: false,
      msgId: Math.floor(Math.random() * 0x7fffffff),
      extra: opts.extra
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      messageId: res.msgId != null ? String(res.msgId) : undefined,
      logId: res.logId != null ? String(res.logId) : undefined,
      raw: res
    };
  }

  /**
   * Synchronize open chat links (LOCO `SYNCLINK`): request { ltk } -> response { ols, dlis, ltk }.
   */
  async syncLink(lastLinkToken = 0): Promise<SyncLinkResult> {
    const pkt = await this.request('SYNCLINK', { ltk: Number(lastLinkToken) });
    const res = pkt.data as Record<string, any>;
    const rawOls = Array.isArray(res.ols) ? res.ols : [];
    const rawDlis = Array.isArray(res.dlis) ? res.dlis : [];
    return {
      status: Number(res.status ?? pkt.header.status),
      openLinks: rawOls.map(parseOpenLink),
      deletedLinkIds: rawDlis.map((id: any) => String(id)),
      lastLinkToken: Number(res.ltk ?? lastLinkToken),
      raw: res
    };
  }

  /**
   * Request upload tokens for a batch of photos (LOCO `MSHIP`).
   * Request { c, t, sl, csl, el, ex } -> response { kl, pl, vhl, vh6l, mtl }.
   */
  async multiPhotoShip(
    chatId: string | number,
    items: Array<{ size: number; checksum: string; ext?: string }>,
    opts: { type?: number; extra?: string } = {}
  ): Promise<MultiPhotoShipResult> {
    const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));
    const pkt = await this.request('MSHIP', {
      c: toLong(chatId),
      t: opts.type ?? 27,
      sl: items.map((i) => BSON.Long.fromNumber(i.size)),
      csl: items.map((i) => i.checksum),
      el: items.map((i) => i.ext ?? 'jpg'),
      ex: opts.extra ?? ''
    });
    const res = pkt.data as Record<string, any>;
    return {
      status: Number(res.status ?? pkt.header.status),
      tokenList: Array.isArray(res.kl) ? res.kl.map(String) : [],
      portList: Array.isArray(res.pl) ? res.pl.map(Number) : [],
      v2slHostList: Array.isArray(res.vhl) ? res.vhl.map(String) : [],
      v2slHost6List: Array.isArray(res.vh6l) ? res.vh6l.map(String) : [],
      mimeTypeList: Array.isArray(res.mtl) ? res.mtl.map(String) : [],
      raw: res
    };
  }

  /** Group photos: MSHIP → per-item trailer MPOST/COMPLETE → one carriage WRITE. ✅ two JPEGs/self-chat. */
  async uploadMultiPhotos(chatId: string, opts: {
    userId: string; items: readonly PhotoUploadItem[]; beforeStep?: () => void;
  }) {
    return uploadPhotoBundle({
      ship: items => this.multiPhotoShip(chatId, items),
      upload: (item, allocation) => uploadPhotoItemToTrailer({ ...allocation, userId: opts.userId,
        data: item.data, appVersion: this.appVersion, os: this.os }),
      publish: extra => this.sendMultiPhotoMessage(chatId, extra), beforeStep: opts.beforeStep
    }, opts.items);
  }

  async sendMultiPhotoMessage(chatId: string, extra: string): Promise<WriteResult> {
    const packet = await this.request('WRITE', { chatId: BSON.Long.fromString(chatId), msg: '', type: 27,
      noSeen: false, msgId: Math.floor(Math.random() * 0x7fffffff), extra });
    const res = packet.data as Record<string, any>;
    return { status: Number(res.status ?? packet.header.status), logId: res.logId != null ? String(res.logId) : undefined,
      messageId: res.msgId != null ? String(res.msgId) : undefined, raw: res };
  }

  /** Pushes not yet seen live (❓); nothing in core consumes these events. */
  private dispatchLaneBPush(method: string, d: Record<string, any>): void {
    if (method === 'SYNCMODMSG') {
      // Message modified by sender
      this.emit('syncmodmsg', {
        chatLog: parseChatLog(d.chatLog ?? d, d),
        modifiedChatLog: d.modifiedChatLog ? parseChatLog(d.modifiedChatLog, d) : undefined,
        raw: d
      });
    } else if (method === 'SYNCDLMSG') {
      // Message deleted by sender / from other device
      this.emit('syncdlmsg', {
        chatLog: parseChatLog(d.chatLog ?? d, d),
        raw: d
      });
    } else if (method === 'SYNCLINKCR') {
      this.emit('synclinkcr', {
        openLink: parseOpenLink(d.openLink ?? d),
        chatRoom: d.chatRoom,
        raw: d
      });
    } else if (method === 'SYNCLINKUP') {
      this.emit('synclinkup', {
        openLink: parseOpenLink(d.openLink ?? d),
        raw: d
      });
    } else if (method === 'SYNCLINKDL') {
      this.emit('synclinkdl', {
        linkId: d.linkId != null ? String(d.linkId) : undefined,
        openLinkToken: typeof d.openLinkToken === 'number' ? d.openLinkToken : undefined,
        lastTokenId: d.lastTokenId != null ? String(d.lastTokenId) : undefined,
        raw: d
      });
    } else if (method === 'SYNCLINKPF') {
      this.emit('synclinkpf', {
        chatId: d.chatId != null ? String(d.chatId) : undefined,
        linkId: d.linkId != null ? String(d.linkId) : undefined,
        openLinkUser: d.openLinkUser,
        raw: d
      });
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LocoError('CLOSED', 'session closed', { command: p.method }));
    }
    this.pending.clear();
    this.emit('close');
  }
}

export interface OpenLocoSessionParams {
  loco: LocoClient;
  booking: BookingResult;
  userId: string | number;
  accessToken: string;
  deviceUUID: string;
  session?: LocoSessionOptions;
  /** How many CHECKIN allocations to try before giving up (default 4). */
  maxAllocations?: number;
  /** Delay between allocation attempts, ms (default 800). */
  backoffMs?: number;
  /** Optional progress logger. */
  log?: (line: string) => void;
}

export interface OpenLocoSessionResult {
  session: LocoSession;
  loginList: LoginListResult;
  endpoint: { host: string; port: number };
}

/**
 * Establish a carriage session resiliently. CHECKIN load-balances to a chat server that is
 * sometimes unreachable from a given network (ETIMEDOUT/EHOSTUNREACH); this re-runs CHECKIN
 * to obtain fresh allocations and fails fast on each via the session's connectTimeoutMs,
 * with a small port hedge (the allocated port, then the booking primary port). Throws only
 * after `maxAllocations` allocations have all failed.
 */
export async function openLocoSession(params: OpenLocoSessionParams): Promise<OpenLocoSessionResult> {
  const { loco, booking, userId, accessToken, deviceUUID } = params;
  const maxAllocations = params.maxAllocations ?? 4;
  const backoffMs = params.backoffMs ?? 800;
  const log = params.log ?? (() => {});
  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= maxAllocations; attempt++) {
    let checkin;
    try {
      checkin = await loco.checkin(booking.ticketHosts[0], booking.ports[0], String(userId));
    } catch (e) {
      lastErr = e as Error;
      log(`[open] attempt ${attempt}: CHECKIN failed`);
      await delay(backoffMs);
      continue;
    }
    if (!checkin.chatHost || !checkin.chatPort) {
      lastErr = new LocoError('UNREACHABLE', 'CHECKIN allocated no chat server', { command: 'CHECKIN' });
      log(`[open] attempt ${attempt}: ${lastErr.message}`);
      await delay(backoffMs);
      continue;
    }

    const candidatePorts = [...new Set([checkin.chatPort, booking.ports[0]])];
    for (const port of candidatePorts) {
      const session = new LocoSession({ ...params.session });
      try {
        log(`[open] attempt ${attempt}: connecting to allocated server`);
        const loginList = await session.connect(checkin.chatHost, port, String(userId), String(accessToken), deviceUUID);
        return { session, loginList, endpoint: { host: checkin.chatHost, port } };
      } catch (e) {
        lastErr = e as Error;
        log('[open] allocated server connection failed');
        session.close();
      }
    }
    await delay(backoffMs);
  }
  throw new LocoError('UNREACHABLE', `openLocoSession: no reachable chat server after ${maxAllocations} allocations`, { cause: lastErr });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fresh credentials returned by an `onAuthFailure` hook. */
export interface RefreshedCredentials {
  accessToken: string;
  /** A re-registered device key, if registration (not just token refresh) happened. */
  deviceUUID?: string;
}

export interface ResilientLocoSessionOptions {
  loco: LocoClient;
  userId: string | number;
  accessToken: string;
  deviceUUID: string;
  session?: LocoSessionOptions;
  /** openLocoSession tuning (per connect attempt). */
  open?: { maxAllocations?: number; backoffMs?: number };
  /** Reconnect backoff after an unexpected drop. */
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number; maxRetries?: number };
  /**
   * Called when LOGINLIST comes back with an auth-failure status (see `isAuthFailure`).
   * Return fresh credentials (e.g. from a token refresh or a re-registration) to retry
   * the connect with, or `null` to give up and surface the failure. Invoked at most once
   * per connect attempt to avoid a refresh loop.
   */
  onAuthFailure?: (ctx: { status: number; accessToken: string; deviceUUID: string }) => Promise<RefreshedCredentials | null>;
  /** Classifies a LOGINLIST status as an auth failure. Default: any non-zero status. */
  isAuthFailure?: (status: number) => boolean;
  log?: (line: string) => void;
}

/**
 * A self-healing LOCO session. Wraps an inner LocoSession and, on an UNEXPECTED drop
 * (socket close not initiated by close()), re-runs GETCONF + CHECKIN + LOGINLIST with
 * exponential backoff and re-emits messages, so a consumer sees one continuous stream.
 *
 * Events: 'connected' ({endpoint, loginList}), 'reconnecting' ({attempt, delayMs}),
 * 'message' (IncomingMessage), 'packet' (LocoPacket), 'close' (final), 'error' (Error).
 */
export class ResilientLocoSession extends EventEmitter {
  private inner?: LocoSession;
  private closing = false;
  private attempt = 0;
  private _endpoint?: { host: string; port: number };
  // Mutable credentials — a token refresh / re-registration updates these in place so
  // every subsequent (re)connect uses the latest values.
  private accessToken: string;
  private deviceUUID: string;

  constructor(private readonly params: ResilientLocoSessionOptions) {
    super();
    this.accessToken = String(params.accessToken);
    this.deviceUUID = params.deviceUUID;
  }

  get endpoint(): { host: string; port: number } | undefined {
    return this._endpoint;
  }

  /** The access token currently in use (updated after a successful refresh). */
  get currentAccessToken(): string {
    return this.accessToken;
  }

  /** Push fresh credentials in (e.g. after an out-of-band refresh); used on the next connect. */
  updateCredentials(creds: RefreshedCredentials): void {
    this.accessToken = creds.accessToken;
    if (creds.deviceUUID) this.deviceUUID = creds.deviceUUID;
  }

  /** Initial connect; resolves with the LOGINLIST result. Throws if the first connect fails. */
  async start(): Promise<LoginListResult> {
    return (await this.connectOnce()).loginList;
  }

  async sendText(chatId: string | number, text: string, opts: WriteOptions = {}): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendText(chatId, text, opts);
  }

  async markRead(chatId: string | number, watermark: string | number): Promise<{ status: number }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.markRead(chatId, watermark);
  }

  async deleteMessage(chatId: string | number, logId: string | number): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.deleteMessage(chatId, logId);
  }

  async sendReply(chatId: string | number, text: string, reply: ReplyTarget, opts: WriteOptions = {}): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendReply(chatId, text, reply, opts);
  }

  async ship(
    chatId: string | number,
    opts: { size: number; type: number; checksum: string; ext?: string; extra?: string }
  ): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.ship(chatId, opts);
  }

  async sendMediaPost(opts: {
    chatId: string | number;
    userId: string | number;
    token: string;
    type: number;
    size: number;
    fileName?: string;
    width?: number;
    height?: number;
    extra?: string;
  }): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendMediaPost(opts);
  }

  async uploadMedia(
    chatId: string | number,
    opts: {
      userId: string | number;
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
  ): Promise<TrailerUploadResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.uploadMedia(chatId, opts);
  }

  async getTrailer(token: string, type: number): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.getTrailer(token, type);
  }

  async downloadMedia(
    chatId: string | number,
    opts: {
      userId: string | number;
      token: string;
      type: number;
      maxBytes?: number;
      offset?: number;
      isMini?: boolean;
      width?: number;
      height?: number;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      sink?: TrailerChunkSink;
    }
  ): Promise<TrailerDownloadResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.downloadMedia(chatId, opts);
  }

  async leave(
    chatId: string | number,
    opts: { block?: boolean; silence?: boolean } = {}
  ): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.leave(chatId, opts);
  }

  async setMeta(
    chatId: string | number,
    type: number,
    content: string | Record<string, unknown>
  ): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.setMeta(chatId, type, content);
  }

  async getMeta(chatId: string | number, types: number[]): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.getMeta(chatId, types);
  }

  async forwardMessage(
    chatId: string | number,
    opts: { type?: number; text: string; extra?: string }
  ): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.forwardMessage(chatId, opts);
  }

  async createChat(
    memberIds: (string | number)[],
    opts?: { pushAlert?: boolean; memoChat?: boolean; nickName?: string }
  ): Promise<{ status: number; chatId?: string; chatRoom?: Record<string, any>; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.createChat(memberIds, opts);
  }

  async chatOnRoom(chatId: string | number, token: string | number = 0): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.chatOnRoom(chatId, token);
  }

  async sendWithMentions(chatId: string | number, text: string, mentions: MentionSpan[], opts: WriteOptions = {}): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendWithMentions(chatId, text, mentions, opts);
  }

  async syncMessages(
    chatId: string | number,
    opts?: { cur?: string | number; max?: string | number; count?: number }
  ): Promise<SyncResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.syncMessages(chatId, opts);
  }

  async chatLogs(chatIds: (string | number)[], sinces: (string | number)[]): Promise<SyncResult & { eof: boolean }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.chatLogs(chatIds, sinces);
  }

  async syncAllMessages(
    chatId: string | number,
    opts: { max: string | number; pageSize?: number; maxPages?: number }
  ): Promise<IncomingMessage[]> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.syncAllMessages(chatId, opts);
  }

  async getChannelMeta(chatId: string | number, selfUserId?: string | number): Promise<ChannelMeta> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.getChannelMeta(chatId, selfUserId);
  }

  async getMembers(chatId: string | number, memberIds: (string | number)[]): Promise<{ status: number; members: ChannelMember[]; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.getMembers(chatId, memberIds);
  }

  request(method: string, body: Record<string, unknown>): Promise<LocoPacket> {
    if (!this.inner || this.inner.isClosed) return Promise.reject(new LocoError('NOT_CONNECTED', 'session not connected'));
    return this.inner.request(method, body);
  }

  /** Simulate a network drop (for testing auto-reconnect). */
  forceDrop(): void {
    this.inner?.forceDrop();
  }

  /** Intentional shutdown — stops reconnection. */
  close(): void {
    this.closing = true;
    this.inner?.close();
  }

  private async connectOnce(allowRefresh = true): Promise<{ loginList: LoginListResult }> {
    const booking = await this.params.loco.getBookingConfig();
    const opened = await openLocoSession({
      loco: this.params.loco,
      booking,
      userId: this.params.userId,
      accessToken: this.accessToken,
      deviceUUID: this.deviceUUID,
      session: this.params.session,
      maxAllocations: this.params.open?.maxAllocations,
      backoffMs: this.params.open?.backoffMs,
      log: this.params.log
    });

    // Detect an auth-failure LOGINLIST (e.g. an expired bearer token). If a refresh hook
    // is configured, obtain fresh credentials and retry the connect exactly once.
    const isAuthFailure = this.params.isAuthFailure ?? ((s: number) => s !== 0);
    if (allowRefresh && this.params.onAuthFailure && isAuthFailure(opened.loginList.status)) {
      this.params.log?.(`[auth] LOGINLIST status ${opened.loginList.status} — attempting credential refresh`);
      opened.session.close();
      let refreshed: RefreshedCredentials | null = null;
      try {
        refreshed = await this.params.onAuthFailure({
          status: opened.loginList.status,
          accessToken: this.accessToken,
          deviceUUID: this.deviceUUID
        });
      } catch (e) {
        this.params.log?.('[auth] refresh hook failed');
      }
      if (refreshed) {
        this.updateCredentials(refreshed);
        this.emit('refreshed', refreshed);
        return this.connectOnce(false); // retry once with new creds, no further refresh
      }
      this.params.log?.('[auth] refresh produced no credentials — surfacing auth failure');
    }

    if (opened.loginList.status !== 0) {
      opened.session.close();
      throw new LocoError('STATUS', `LOGINLIST failed with status ${opened.loginList.status}`, { command: 'LOGINLIST', status: opened.loginList.status });
    }

    this.inner = opened.session;
    this._endpoint = opened.endpoint;
    this.attempt = 0;
    this.wire(opened.session);
    // The session is live and wired: never reject past this point, or a reconnect loop would open a
    // second connection on the same device key while this one keeps running.
    try {
      this.emit('connected', { endpoint: opened.endpoint, loginList: opened.loginList });
    } catch (e) {
      try {
        if (this.listenerCount('error') > 0) this.emit('error', e instanceof Error ? e : new Error(String(e)));
      } catch {
        // ignored: see above
      }
    }
    return { loginList: opened.loginList };
  }

  private wire(s: LocoSession): void {
    s.on('message', (m) => this.emit('message', m));
    s.on('read', (r) => this.emit('read', r));
    s.on('packet', (p) => this.emit('packet', p));
    s.on('error', (e) => this.emit('error', e));
    s.on('syncmodmsg', (m) => this.emit('syncmodmsg', m));
    s.on('syncdlmsg', (d) => this.emit('syncdlmsg', d));
    s.on('synclinkcr', (c) => this.emit('synclinkcr', c));
    s.on('synclinkup', (u) => this.emit('synclinkup', u));
    s.on('synclinkdl', (d) => this.emit('synclinkdl', d));
    s.on('synclinkpf', (p) => this.emit('synclinkpf', p));
    s.once('close', () => this.onDrop());
  }

  private onDrop(): void {
    if (this.closing) { this.emit('close'); return; }
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    const base = this.params.reconnect?.baseDelayMs ?? 1000;
    const max = this.params.reconnect?.maxDelayMs ?? 30000;
    const maxRetries = this.params.reconnect?.maxRetries ?? Infinity;
    while (!this.closing && this.attempt < maxRetries) {
      this.attempt++;
      const delayMs = Math.min(max, base * 2 ** (this.attempt - 1));
      this.emit('reconnecting', { attempt: this.attempt, delayMs });
      await delay(delayMs);
      if (this.closing) break;
      try {
        await this.connectOnce(); // resets attempt + emits 'connected' on success
        return;
      } catch (e) {
        this.emit('error', e as Error);
      }
    }
    if (!this.closing) this.emit('close');
  }

  // --- queued protocols (unverified live) ---
  async modifyMessage(chatId: string | number, logId: string | number, text: string, opts?: { type?: number; extra?: string }): Promise<ModifyMessageResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.modifyMessage(chatId, logId, text, opts);
  }

  async sendEmoticon(chatId: string | number, opts: { emoticon: EmoticonAttachment; text?: string; type?: number }): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendEmoticon(chatId, opts);
  }

  async sendEmoticonRaw(chatId: string | number, opts: { type: number; extra: string; text?: string }): Promise<WriteResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.sendEmoticonRaw(chatId, opts);
  }

  async syncLink(lastLinkToken?: number): Promise<SyncLinkResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.syncLink(lastLinkToken);
  }

  async multiPhotoShip(chatId: string | number, items: Array<{ size: number; checksum: string; ext?: string }>, opts?: { type?: number; extra?: string }): Promise<MultiPhotoShipResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.multiPhotoShip(chatId, items, opts);
  }

  async uploadMultiPhotos(chatId: string, opts: { userId: string; items: readonly PhotoUploadItem[]; beforeStep?: () => void }) {
    if (!this.inner) throw new LocoError('NOT_CONNECTED', 'LOCO session is not connected');
    return this.inner.uploadMultiPhotos(chatId, opts);
  }

  // --- block list ---
  async syncBlockList(opts?: { revision?: number; plusRevision?: number }): Promise<BlockSyncResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.syncBlockList(opts);
  }

  async getBlockMembers(blockIds: (string | number)[], plusBlockIds?: (string | number)[]): Promise<BlockMemberResult> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.getBlockMembers(blockIds, plusBlockIds);
  }

  async addBlockItem(userIds: (string | number)[], blockTypes?: number[]): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.addBlockItem(userIds, blockTypes);
  }

  async deleteBlockItem(userIds: (string | number)[]): Promise<{ status: number; raw: Record<string, any> }> {
    if (!this.inner || this.inner.isClosed) throw new LocoError('NOT_CONNECTED', 'session not connected');
    return this.inner.deleteBlockItem(userIds);
  }
}
