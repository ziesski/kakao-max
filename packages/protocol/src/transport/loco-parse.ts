// ----------------------------------------------------------------------------
// Pure parsers from decoded LOCO packet bodies to the library's types.
//
// Kept free of sockets and crypto so they can be exercised against recorded
// (sanitized) packets in replay tests. Ids may arrive as numbers, BSON Longs, or
// strings (in fixtures); all are normalized with String().
// ----------------------------------------------------------------------------

import type { ConversationItem } from './loco-client.js';
import type { ChannelMeta, ChannelMember, IncomingMessage, ReadReceipt, SyncResult } from './loco-session.js';

const idStr = (v: unknown): string => (v == null ? '' : String(v));

/** Normalize a LOCO chatLog (from MSG push or SYNCMSG) into an IncomingMessage. */
export function parseChatLog(log: Record<string, any>, envelope?: Record<string, any>): IncomingMessage {
  return {
    chatId: idStr(log.chatId ?? envelope?.chatId),
    authorId: log.authorId != null ? String(log.authorId) : undefined,
    messageId: log.logId != null ? String(log.logId) : log.msgId != null ? String(log.msgId) : undefined,
    type: typeof log.type === 'number' ? log.type : undefined,
    text: typeof log.message === 'string' ? log.message : typeof log.msg === 'string' ? log.msg : undefined,
    sendAt: typeof log.sendAt === 'number' ? log.sendAt : undefined,
    attachment: log.attachment ?? log.extra ?? undefined,
    raw: log
  };
}

/** The conversation list from a LOGINLIST (or LCHATLIST) response body. */
export function parseLoginList(res: Record<string, any>): ConversationItem[] {
  if (!Array.isArray(res.chatDatas)) return [];
  return res.chatDatas.map((c: any) => {
    const last = c.l;
    const lastMsg = typeof last?.message === 'string' ? last.message : typeof last?.msg === 'string' ? last.msg : undefined;
    const lastSendAt = typeof last?.sendAt === 'number' ? last.sendAt : typeof last?.s === 'number' ? last.s : undefined;
    return {
      id: idStr(c.c ?? c.channelId),
      type: String(c.t ?? c.type ?? ''),
      unreadCount: typeof c.n === 'number' ? c.n : typeof c.u === 'number' ? c.u : undefined,
      lastMessage: lastMsg,
      lastSendAt,
      lastMessageType: typeof last?.type === 'number' ? last.type : undefined,
      memberCount: typeof c.a === 'number' ? c.a : undefined,
      raw: c
    };
  });
}

/** A DECUNREAD push: a participant read `chatId` up to `watermark`. */
export function parseReadReceipt(d: Record<string, any>): ReadReceipt {
  return {
    chatId: idStr(d.chatId),
    userId: d.userId != null ? String(d.userId) : d.memberId != null ? String(d.memberId) : undefined,
    watermark: d.watermark != null ? String(d.watermark) : undefined,
    raw: d
  };
}

/** One member object as GETMEM, CHATINFO `displayMembers` and MEMBER return it. */
export function parseMember(m: Record<string, any>): ChannelMember {
  return {
    userId: String(m.userId),
    name: m.chatRoomNickname || m.friendNickName || m.nickName || String(m.userId),
    profileImageUrl: m.profileImageUrl || undefined
  };
}

/**
 * Channel metadata from GETMEM (`mem`) and CHATINFO (`info`) response bodies; either
 * may be null when its request failed. A 1:1 is titled by the other member, an
 * unnamed group by its members' names joined.
 */
export function parseChannelMeta(
  chatId: string | number,
  mem: Record<string, any> | null | undefined,
  info: Record<string, any> | null | undefined,
  selfUserId?: string | number
): ChannelMeta {
  const rawMembers: any[] = mem?.members ?? info?.chatInfo?.displayMembers ?? [];
  const members = rawMembers.map(parseMember);
  const room = info?.chatInfo;
  const named = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return undefined; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };
  const titleValue = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
  const custom = named(room?.mcMetas);
  let groupName = titleValue(custom?.name);
  let titleSource: ChannelMeta['titleSource'] = groupName ? 'custom' : 'participants';
  // Shared room titles live in chatMetas[type=3], separately from the user's
  // mcMetas name. Never treat notices, bot metadata, or message bodies as titles.
  if (!groupName) {
    const entries = Array.isArray(room?.chatMetas) ? room.chatMetas : [];
    for (const entry of entries) {
      if (entry?.type !== 3) continue;
      groupName = titleValue(entry.content);
      if (groupName) { titleSource = 'shared'; break; }
    }
  }
  const others = selfUserId != null ? members.filter((m) => m.userId !== String(selfUserId)) : members;
  const title = groupName || (others.length ? others.map((m) => m.name).join(', ') : 'Chat');
  const rawLast = info?.chatInfo?.lastLogId;
  const lastLogId = rawLast != null ? String(rawLast) : undefined;
  return {
    chatId: String(chatId),
    title,
    titleSource,
    isGroup: Boolean(groupName) || members.length > 2,
    ...(typeof room?.type === 'string' && room.type ? { type: room.type } : {}),
    members,
    lastLogId: lastLogId && lastLogId !== '0' ? lastLogId : undefined,
    raw: { members: mem, info }
  };
}

/** A SYNCMSG response body (with the packet header status as fallback). */
export function parseSyncResult(res: Record<string, any>, headerStatus?: number): SyncResult {
  const logs = Array.isArray(res.chatLogs) ? res.chatLogs : [];
  return {
    status: Number(res.status ?? headerStatus),
    messages: logs.map((l: Record<string, any>) => parseChatLog(l)),
    hasMore: res.isOK === false || res.hasMore === true,
    raw: res
  };
}

// ----------------------------------------------------------------------------
// Emoticon definitions & builders (unverified live)
// ----------------------------------------------------------------------------

export type EmoticonItemType = 'EMOTICON' | 'STICKER' | 'STICKER_ANI' | 'SCON' | 'XCON';

/**
 * Emoticon attachment. Live (2026-10-19) a received type 20 emoticon carried
 * `{ alt, emoticonItemPath, kid, name, path }` and no `itemType`; the message type says which kind it is.
 */
export interface EmoticonAttachment {
  name: string;
  path: string;
  itemType?: EmoticonItemType;
  alt?: string;
  emoticonItemPath?: string;
  welcome?: boolean;
  sound?: string;
  scon?: string;
  path2?: string;
  width?: number;
  height?: number;
  xconVersion?: number;
  kid?: number[];
}

/** Get LOCO message type code for an emoticon itemType. */
export function getEmoticonType(itemType: EmoticonItemType): number {
  switch (itemType) {
    case 'EMOTICON': return 6;
    case 'STICKER': return 12;
    case 'STICKER_ANI': return 20;
    case 'SCON': return 22;
    case 'XCON': return 25;
  }
}

/** Build JSON string for emoticon extra payload. */
export function buildEmoticonExtra(opts: EmoticonAttachment): string {
  const obj: Record<string, any> = {
    name: opts.name,
    path: opts.path
  };
  if (opts.itemType) obj.itemType = opts.itemType;
  if (opts.alt) obj.alt = opts.alt;
  if (opts.emoticonItemPath) obj.emoticonItemPath = opts.emoticonItemPath;
  if (opts.welcome) obj.welcome = true;
  if (opts.sound) obj.sound = opts.sound;
  if (opts.scon) obj.scon = opts.scon;
  if (opts.path2) obj.path2 = opts.path2;
  if (opts.width != null) obj.width = opts.width;
  if (opts.height != null) obj.height = opts.height;
  if (opts.xconVersion != null) obj.xconVersion = opts.xconVersion;
  if (opts.kid && opts.kid.length > 0) obj.kid = opts.kid;
  return JSON.stringify(obj);
}

/** Parse an emoticon extra/attachment JSON. */
export function parseEmoticonAttachment(extra: string | Record<string, any>): EmoticonAttachment | null {
  let parsed: Record<string, any>;
  if (typeof extra === 'string') {
    try {
      parsed = JSON.parse(extra);
    } catch {
      return null;
    }
  } else if (extra && typeof extra === 'object') {
    parsed = extra;
  } else {
    return null;
  }
  if (!parsed.name || !parsed.path) return null;
  return {
    name: String(parsed.name),
    path: String(parsed.path),
    itemType: parsed.itemType ? (parsed.itemType as EmoticonItemType) : undefined,
    alt: parsed.alt ? String(parsed.alt) : undefined,
    emoticonItemPath: parsed.emoticonItemPath ? String(parsed.emoticonItemPath) : undefined,
    welcome: parsed.welcome === true ? true : undefined,
    sound: parsed.sound ? String(parsed.sound) : undefined,
    scon: parsed.scon ? String(parsed.scon) : undefined,
    path2: parsed.path2 ? String(parsed.path2) : undefined,
    width: typeof parsed.width === 'number' ? parsed.width : undefined,
    height: typeof parsed.height === 'number' ? parsed.height : undefined,
    xconVersion: typeof parsed.xconVersion === 'number' ? parsed.xconVersion : undefined,
    kid: Array.isArray(parsed.kid) ? parsed.kid.map(Number) : undefined
  };
}

// ----------------------------------------------------------------------------
// MultiPhoto definitions & builders (unverified live)
// ----------------------------------------------------------------------------

export interface MultiPhotoItem {
  token: string;
  width: number;
  height: number;
  size: number;
  mimeType: string;
  checksum: string;
  comment?: string;
}

export interface MultiPhotoAttachment {
  items: MultiPhotoItem[];
  raw: Record<string, any>;
}

/** Build JSON string for a multi-photo attachment { kl, wl, hl, sl, mtl, csl, cmtl }. */
export function buildMultiPhotoExtra(items: MultiPhotoItem[]): string {
  return JSON.stringify({
    kl: items.map((i) => i.token),
    wl: items.map((i) => i.width),
    hl: items.map((i) => i.height),
    sl: items.map((i) => i.size),
    mtl: items.map((i) => i.mimeType),
    csl: items.map((i) => i.checksum),
    cmtl: items.map((i) => i.comment ?? '')
  });
}

/** Parse a multi-photo attachment. */
export function parseMultiPhotoAttachment(extra: string | Record<string, any>): MultiPhotoAttachment | null {
  let parsed: Record<string, any>;
  if (typeof extra === 'string') {
    try {
      parsed = JSON.parse(extra);
    } catch {
      return null;
    }
  } else if (extra && typeof extra === 'object') {
    parsed = extra;
  } else {
    return null;
  }
  const kl: string[] = Array.isArray(parsed.kl) ? parsed.kl.map(String) : [];
  if (kl.length === 0) return null;
  const wl: number[] = Array.isArray(parsed.wl) ? parsed.wl.map(Number) : [];
  const hl: number[] = Array.isArray(parsed.hl) ? parsed.hl.map(Number) : [];
  const sl: number[] = Array.isArray(parsed.sl) ? parsed.sl.map(Number) : [];
  const mtl: string[] = Array.isArray(parsed.mtl) ? parsed.mtl.map(String) : [];
  const csl: string[] = Array.isArray(parsed.csl) ? parsed.csl.map(String) : [];
  const cmtl: string[] = Array.isArray(parsed.cmtl) ? parsed.cmtl.map(String) : [];

  const items: MultiPhotoItem[] = kl.map((token, idx) => ({
    token,
    width: wl[idx] ?? 0,
    height: hl[idx] ?? 0,
    size: sl[idx] ?? 0,
    mimeType: mtl[idx] ?? 'image/jpeg',
    checksum: csl[idx] ?? '',
    comment: cmtl[idx] || undefined
  }));

  return { items, raw: parsed };
}

// ----------------------------------------------------------------------------
// OpenLink definitions & parsers (unverified live)
// ----------------------------------------------------------------------------

export interface OpenLinkUser {
  userId: string;
  nickname: string;
  profileImageUrl?: string;
  originalProfileImageUrl?: string;
  linkId?: string;
  privilege?: number;
}

export interface OpenLinkItem {
  linkId: string;
  linkToken: number;
  linkName: string;
  linkUrl: string;
  linkDescription?: string;
  linkImageUrl?: string;
  linkIconUrl?: string;
  openLinkUser?: OpenLinkUser;
  viewType: number;
  linkType: number;
  memberLimit?: number;
  memberCount?: number;
  active: boolean;
  createdAt: number;
  searchable: boolean;
  privilege?: string;
  reactionType?: number;
  reactionCount?: number;
  raw: Record<string, any>;
}

export function parseOpenLink(l: Record<string, any>): OpenLinkItem {
  const u = l.openLinkUser ?? l.olu;
  const user: OpenLinkUser | undefined = u
    ? {
        userId: String(u.userId ?? u.userIdLong ?? ''),
        nickname: String(u.nickname ?? u.nn ?? ''),
        profileImageUrl: u.profileImageUrl ? String(u.profileImageUrl) : undefined,
        originalProfileImageUrl: u.originalProfileImageUrl ? String(u.originalProfileImageUrl) : undefined,
        linkId: u.linkId != null ? String(u.linkId) : undefined,
        privilege: typeof u.privilege === 'number' ? u.privilege : undefined
      }
    : undefined;

  return {
    linkId: idStr(l.linkId ?? l.li),
    linkToken: Number(l.linkToken ?? l.lt ?? 0),
    linkName: String(l.linkName ?? l.ln ?? ''),
    linkUrl: String(l.linkUrl ?? l.lu ?? ''),
    linkDescription: l.linkDescription ? String(l.linkDescription) : undefined,
    linkImageUrl: l.linkImageUrl ? String(l.linkImageUrl) : undefined,
    linkIconUrl: l.linkIconUrl ? String(l.linkIconUrl) : undefined,
    openLinkUser: user,
    viewType: Number(l.viewType ?? l.vt ?? 0),
    linkType: Number(l.linkType ?? l.ltp ?? 0),
    memberLimit: typeof l.memberLimit === 'number' ? l.memberLimit : undefined,
    memberCount: typeof l.memberCount === 'number' ? l.memberCount : undefined,
    active: l.active === true || l.act === true,
    createdAt: Number(l.createdAt ?? l.ca ?? 0),
    searchable: l.searchable === true || l.sch === true,
    privilege: l.privilege != null ? String(l.privilege) : undefined,
    reactionType: typeof l.reactionType === 'number' ? l.reactionType : undefined,
    reactionCount: typeof l.reactionCount === 'number' ? l.reactionCount : undefined,
    raw: l
  };
}
