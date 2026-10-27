// ----------------------------------------------------------------------------
// Persistent message store backed by the `messages` table of KakaoDb.
//
// Messages are keyed by LOCO logId (messageId). Re-saving a known id merges the
// new fields into the stored row (e.g. a later authorName) and reports "not
// inserted", which callers use to count genuinely new messages. BSON Longs in
// `raw` are stored and read back as decimal strings (long-json.ts).
//
// "Delete for me" is a local hide, as in KakaoTalk itself: hidden ids are
// listed in `hidden_messages` and left out of reads; the rows themselves stay.
// ----------------------------------------------------------------------------

import type { StatementSync } from 'node:sqlite';
import { logNum, type KakaoDb } from './db.ts';
import { longReplacer, longReviver } from './long-json.ts';
import { KakaoError } from './errors.ts';

export interface StoredMessage {
  seq: number;
  chatId: string;
  messageId: string; // logId
  authorId: string;
  authorName?: string;
  /** LOCO message type; absent when the server did not send one. */
  type?: number;
  text: string;
  attachment?: string;
  sendAt: number;
  raw?: any;
}

interface Row extends Record<string, import('node:sqlite').SQLOutputValue> {
  message_id: string;
  chat_id: string;
  seq: number;
  author_id: string;
  author_name: string | null;
  type: number | null;
  text: string;
  attachment: string | null;
  send_at: number;
  raw: string | null;
}

const COLUMNS = 'message_id, chat_id, seq, author_id, author_name, type, text, attachment, send_at, raw';
const NOT_HIDDEN = 'message_id NOT IN (SELECT message_id FROM hidden_messages)';
const NOT_DELETED = '(type IS NULL OR (type & 16384) = 0)';

export interface HideResult {
  /** Ids hidden by this call. */
  hidden: string[];
  /** Ids that were already hidden. */
  alreadyHidden: string[];
  /** Ids hidden although no such message is stored in the chat yet (it stays hidden if it arrives). */
  notStored: string[];
}

function fromRow(r: Row): StoredMessage {
  const authorId = r.author_id != null ? String(r.author_id).replace(/\.0$/, '') : '';
  const m: StoredMessage = {
    seq: r.seq,
    chatId: String(r.chat_id),
    messageId: String(r.message_id),
    authorId,
    text: r.text,
    sendAt: r.send_at
  };
  if (r.author_name != null) m.authorName = r.author_name;
  if (r.type != null) m.type = r.type;
  if (r.attachment != null) m.attachment = r.attachment;
  if (r.raw != null) m.raw = JSON.parse(r.raw, longReviver);
  return m;
}

/** Revisions are exact nonnegative integers; absent/invalid values are never guessed. */
export function messageRevision(m: StoredMessage): bigint | undefined {
  const value = m.raw?.cloudMetadata?.revision ?? m.raw?.revision;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,19}$/.test(value)) return BigInt(value);
  return undefined;
}

export interface CloudSaveCounts { inserted: number; updated: number; alreadyStored: number }

export class MessageStore {
  private readonly kdb: KakaoDb;
  private readonly upsertStmt: StatementSync;
  private readonly getStmt: StatementSync;

  constructor(kdb: KakaoDb) {
    this.kdb = kdb;
    this.upsertStmt = kdb.db.prepare(
      `INSERT INTO messages (${COLUMNS}, log_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         chat_id = excluded.chat_id, seq = excluded.seq, author_id = excluded.author_id,
         author_name = excluded.author_name, type = excluded.type, text = excluded.text,
         attachment = excluded.attachment, send_at = excluded.send_at, raw = excluded.raw`
    );
    this.getStmt = kdb.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE message_id = ?`);
  }

  /** Insert or merge a message. Returns true only when the id was not stored before. */
  saveMessage(m: StoredMessage): boolean {
    const existing = this.getStmt.get(m.messageId) as Row | undefined;
    if (existing && existing.chat_id !== String(m.chatId)) throw new KakaoError('HISTORY_CONFLICT', 'Message identity belongs to another room; refusing to overwrite');
    // Merge like the previous in-memory store: later fields win, absent ones keep old values.
    const merged: StoredMessage = existing ? { ...fromRow(existing), ...stripUndefined(m) } : m;
    this.upsertStmt.run(
      String(merged.messageId),
      String(merged.chatId),
      merged.seq,
      String(merged.authorId || '').replace(/\.0$/, ''),
      merged.authorName ?? null,
      merged.type ?? null,
      merged.text,
      merged.attachment ?? null,
      merged.sendAt,
      merged.raw === undefined ? null : JSON.stringify(merged.raw, longReplacer),
      logNum(merged.messageId)
    );
    return !existing;
  }

  /** Incoming/backfilled copies keep a type flag already recorded for the message. */
  saveReceivedMessage(m: StoredMessage): boolean {
    const previous = this.getMessage(m.chatId, m.messageId);
    return this.saveMessage(previous?.type != null && (previous.type & 16384) !== 0
      ? { ...m, type: (m.type ?? previous.type) | 16384 } : m);
  }

  /** One stored message by chat and logId (hidden ones included), or undefined. */
  getMessage(chatId: string, messageId: string): StoredMessage | undefined {
    const row = this.getStmt.get(messageId) as Row | undefined;
    return row && row.chat_id === chatId ? fromRow(row) : undefined;
  }

  /** Kept for API compatibility; the database is closed through KakaoDb. */
  async close(): Promise<void> {}

  /** Atomically fill restored history gaps without overwriting newer/local message state. */
  saveMissingMessages(messages: readonly StoredMessage[], onCommit?: (inserted: number) => void): number {
    return this.kdb.transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        if (!this.getStmt.get(message.messageId) && this.saveMessage(message)) inserted++;
      }
      onCommit?.(inserted);
      return inserted;
    });
  }

  /** Apply only provably newer cloud revisions; the whole page/checkpoint is atomic. */
  saveCloudMessages(messages: readonly StoredMessage[], onCommit?: (counts: CloudSaveCounts) => void): CloudSaveCounts {
    return this.kdb.transaction(() => {
      const counts = { inserted: 0, updated: 0, alreadyStored: 0 };
      for (const incoming of messages) {
        const row = this.getStmt.get(incoming.messageId) as Row | undefined;
        if (!row) { this.saveMessage(incoming); counts.inserted++; continue; }
        const existing = fromRow(row);
        if (existing.chatId !== incoming.chatId || existing.authorId !== incoming.authorId || existing.sendAt !== incoming.sendAt) {
          throw new KakaoError('HISTORY_CONFLICT', 'Cloud record identity differs from the stored message');
        }
        const before = messageRevision(existing), after = messageRevision(incoming);
        if (before === undefined || after === undefined || after < before || (existing.type != null && (existing.type & 16384) !== 0)) {
          counts.alreadyStored++; continue;
        }
        if (after === before) {
          if (existing.text !== incoming.text || existing.type !== incoming.type || (existing.attachment ?? '') !== (incoming.attachment ?? '')) {
            throw new KakaoError('HISTORY_CONFLICT', 'Cloud payload conflicts with the stored revision');
          }
          counts.alreadyStored++; continue;
        }
        // Keep sequence/name and local hidden state; a cloud record never unhides a message.
        this.saveMessage({ ...incoming, seq: existing.seq, authorName: existing.authorName ?? incoming.authorName });
        counts.updated++;
      }
      onCommit?.(counts);
      return counts;
    });
  }

  /**
   * The newest `limit` messages of a chat, oldest first. `beforeLogId`/`afterLogId`
   * are exclusive bounds; ids that are not numeric are never filtered out.
   */
  getMessages(
    chatId: string,
    opts: { limit?: number; beforeLogId?: string; afterLogId?: string; includeHidden?: boolean; includeDeleted?: boolean } = {}
  ): StoredMessage[] {
    const where = ['chat_id = ?'];
    if (!opts.includeHidden) where.push(NOT_HIDDEN);
    if (!opts.includeDeleted) where.push(NOT_DELETED);
    const params: Array<string | number | bigint> = [chatId];
    const before = opts.beforeLogId ? logNum(opts.beforeLogId) : null;
    const after = opts.afterLogId ? logNum(opts.afterLogId) : null;
    if (before != null) {
      where.push('(log_num IS NULL OR log_num < ?)');
      params.push(before);
    }
    if (after != null) {
      where.push('(log_num IS NULL OR log_num > ?)');
      params.push(after);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, Number.MAX_SAFE_INTEGER));
    params.push(limit);
    const rows = this.kdb.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY send_at DESC, log_num DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.reverse().map(fromRow);
  }

  /** Date-bounded keyset page. Timestamp ties use exact numeric log IDs. */
  getRangePage(chatId: string, opts: { from: number; to: number; maxLogId: string;
    before?: { sendAt: number; logId: string }; limit: number }) {
    const where = ['chat_id = ?', NOT_HIDDEN, NOT_DELETED, 'send_at >= ?', 'send_at < ?', 'log_num <= ?'];
    const params: Array<string | number | bigint> = [chatId, opts.from, opts.to, logNum(opts.maxLogId)!];
    if (opts.before) {
      where.push('(send_at < ? OR (send_at = ? AND log_num < ?))');
      params.push(opts.before.sendAt, opts.before.sendAt, logNum(opts.before.logId)!);
    }
    params.push(opts.limit + 1);
    const rows = this.kdb.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY send_at DESC, log_num DESC LIMIT ?`)
      .all(...params) as Row[];
    const page = rows.slice(0, opts.limit).map(fromRow);
    const oldest = page.at(-1);
    return { messages: page.reverse(), next: rows.length > opts.limit && oldest
      ? { sendAt: oldest.sendAt, logId: oldest.messageId } : null };
  }

  /** Substring search over message text (case-insensitive for ASCII), newest first. Excludes hidden and deleted. */
  search(query: string, opts: { chatId?: string; limit?: number; authorId?: string } = {}): StoredMessage[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const where = ['instr(lower(text), ?) > 0', NOT_HIDDEN, NOT_DELETED];
    const params: Array<string | number> = [q];
    if (opts.chatId) {
      where.push('chat_id = ?');
      params.push(opts.chatId);
    }
    if (opts.authorId) {
      where.push('author_id = ?');
      params.push(opts.authorId);
    }
    params.push(opts.limit ?? 20);
    const rows = this.kdb.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY send_at DESC, log_num DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(fromRow);
  }

  /** Mark a message as deleted on this device (sets the 0x4000 bit on type, matching server convention). */
  markDeleted(chatId: string, messageId: string): boolean {
    const info = this.kdb.db
      .prepare(`UPDATE messages SET type = CASE WHEN type IS NOT NULL THEN (type | 16384) ELSE 16384 END WHERE chat_id = ? AND message_id = ?`)
      .run(chatId, messageId);
    return Number(info.changes) > 0;
  }

  /** Hide messages of one chat from every read ("delete for me" on this device). Nothing is sent. */
  hideMessages(chatId: string, messageIds: string[], now = Math.floor(Date.now() / 1000)): HideResult {
    const result: HideResult = { hidden: [], alreadyHidden: [], notStored: [] };
    const existing = this.kdb.db.prepare('SELECT chat_id FROM hidden_messages WHERE message_id = ?');
    const stored = this.kdb.db.prepare('SELECT 1 FROM messages WHERE message_id = ? AND chat_id = ?');
    const insert = this.kdb.db.prepare('INSERT INTO hidden_messages (message_id, chat_id, hidden_at) VALUES (?, ?, ?)');
    this.kdb.transaction(() => {
      for (const id of new Set(messageIds)) {
        if (existing.get(id)) {
          result.alreadyHidden.push(id);
          continue;
        }
        insert.run(id, chatId, now);
        result.hidden.push(id);
        if (!stored.get(id, chatId)) result.notStored.push(id);
      }
    });
    return result;
  }

  /** The hidden ids among `messageIds`. */
  hiddenIds(messageIds: string[]): Set<string> {
    const stmt = this.kdb.db.prepare('SELECT 1 FROM hidden_messages WHERE message_id = ?');
    return new Set(messageIds.filter((id) => stmt.get(id)));
  }

  /** The deleted ids among `messageIds` (messages with 0x4000 bit set on type). */
  deletedIds(messageIds: string[]): Set<string> {
    if (messageIds.length === 0) return new Set();
    const stmt = this.kdb.db.prepare('SELECT 1 FROM messages WHERE message_id = ? AND type IS NOT NULL AND (type & 16384) != 0');
    return new Set(messageIds.filter((id) => stmt.get(id)));
  }

  /** Return the highest messageId (by send_at / log_num) stored for this chat, or undefined. */
  getNewestLogId(chatId: string): string | undefined {
    const row = this.kdb.db
      .prepare('SELECT message_id FROM messages WHERE chat_id = ? ORDER BY send_at DESC, log_num DESC LIMIT 1')
      .get(chatId) as { message_id: string } | undefined;
    return row?.message_id;
  }

  /** Return the highest messageId stored for this chat from an author other than `selfUserId`, or undefined. */
  getNewestLogIdFromOther(chatId: string, selfUserId: string): string | undefined {
    const cleanSelf = selfUserId.replace(/\.0$/, '');
    const row = this.kdb.db
      .prepare('SELECT message_id FROM messages WHERE chat_id = ? AND replace(author_id, \'.0\', \'\') != ? ORDER BY send_at DESC, log_num DESC LIMIT 1')
      .get(chatId, cleanSelf) as { message_id: string } | undefined;
    return row?.message_id;
  }

  getChatStats(chatId: string): { messageCount: number; lastSendAt?: number; lastMessage?: string; lastType?: number } {
    const count = this.kdb.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND ${NOT_HIDDEN} AND ${NOT_DELETED}`).get(chatId) as {
      n: number;
    };
    const last = this.kdb.db
      .prepare(`SELECT text, type, send_at FROM messages WHERE chat_id = ? AND ${NOT_HIDDEN} AND ${NOT_DELETED} ORDER BY send_at DESC, log_num DESC LIMIT 1`)
      .get(chatId) as { text: string; type: number | null; send_at: number } | undefined;
    return {
      messageCount: Number(count.n),
      lastSendAt: last?.send_at,
      lastMessage: last?.text,
      lastType: last?.type ?? undefined
    };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
