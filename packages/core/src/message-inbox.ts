// Durable work references existing messages; contents are never copied to a second queue.
// This is installation/account scoped, with competing consumers and explicit lease/ack.
import { randomUUID } from 'node:crypto';
import type { KakaoDb } from './db.ts';
import { MessageStore, type StoredMessage } from './message-store.ts';
import { KakaoError } from './errors.ts';

export interface InboxEvent {
  eventId: string; sequence: string; messageId: string; leaseId: string; leaseUntil: number; attempts: number; message: StoredMessage;
}
export interface InboxClaim { sourceGeneration: string; events: InboxEvent[]; hasMore: boolean; }
const MAX_BATCH = 200;
function id(value: unknown, zero = false): value is string {
  return typeof value === 'string' && (zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(value) && BigInt(value) <= 9223372036854775807n;
}
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value); }
function invalid(): never { throw new KakaoError('INVALID_ARGUMENT', 'Invalid bounded inbox request or canonical source identity'); }
function io<T>(work: () => T): T {
  try { return work(); }
  catch (cause) { if (cause instanceof KakaoError) throw cause; throw new KakaoError('INTERNAL', 'Message inbox storage failed; no acknowledgement was assumed', { cause }); }
}
interface EventRow extends Record<string, import('node:sqlite').SQLOutputValue> { event_id: string; sequence: string; message_id: string; attempts: number; }
const VISIBLE = `EXISTS (SELECT 1 FROM messages m WHERE m.message_id=e.message_id AND m.chat_id=e.chat_id
  AND (m.type IS NULL OR (m.type & 16384)=0))
  AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id=e.message_id)`;
const AVAILABLE = `(e.state='pending' OR (e.state='leased' AND e.lease_until <= ?))`;

export class MessageInbox {
  readonly sourceGeneration: string;
  private readonly db: KakaoDb;
  private readonly store: MessageStore;
  private readonly now: () => number;
  constructor(db: KakaoDb, accountId: string, now: () => number = Date.now) {
    if (!id(accountId)) invalid();
    this.db = db; this.store = new MessageStore(db); this.now = now;
    // Queue checkpoints, source identity and claims require durable commit before notification.
    db.db.exec('PRAGMA synchronous = FULL');
    this.sourceGeneration = io(() => db.transaction(() => {
      const raw = db.getMeta('message-inbox-source');
      if (raw) {
        let source: { generation?: string; accountId?: string };
        try { source = JSON.parse(raw); } catch { throw new KakaoError('CONFIG_INVALID', 'Invalid inbox source identity'); }
        if (!source || source.accountId !== accountId || !uuid(source.generation)) throw new KakaoError('CONFIG_INVALID', 'Inbox account/source identity changed; manual recovery required');
        return source.generation;
      }
      if ((db.db.prepare('SELECT COUNT(*) AS n FROM message_inbox_events').get() as { n: number }).n ||
          (db.db.prepare('SELECT COUNT(*) AS n FROM message_ingestion_cursors').get() as { n: number }).n) throw new KakaoError('CONFIG_INVALID', 'Inbox source identity missing; refusing to reset checkpoints');
      const generation = randomUUID(); db.setMeta('message-inbox-source', JSON.stringify({ generation, accountId })); return generation;
    }, 'immediate'));
  }
  private checkpoint(chatId: string): { cursor: string; observed_head: string } {
    if (!id(chatId)) invalid();
    return io(() => (this.db.db.prepare('SELECT cursor,observed_head FROM message_ingestion_cursors WHERE chat_id=?').get(chatId) as { cursor: string; observed_head: string } | undefined) ?? { cursor: '0', observed_head: '0' });
  }
  /** Ordered collector progress and observed push high-water are deliberately separate. */
  cursor(chatId: string): string { return this.checkpoint(chatId).cursor; }
  observedHead(chatId: string): string { return this.checkpoint(chatId).observed_head; }
  private save(messages: readonly StoredMessage[]): { inserted: number; eventsCreated: number } {
    let inserted = 0, eventsCreated = 0;
    for (const message of messages) {
      if (this.store.saveReceivedMessage(message)) inserted++;
      eventsCreated += Number(this.db.db.prepare(`INSERT INTO message_inbox_events(event_id,chat_id,message_id,created_at)
        VALUES(?,?,?,?) ON CONFLICT(chat_id,message_id) DO NOTHING`).run(randomUUID(), message.chatId, message.messageId, this.now()).changes);
    }
    return { inserted, eventsCreated };
  }
  private validate(chatId: string, records: readonly StoredMessage[]): void {
    if (!id(chatId) || !Array.isArray(records) || records.length < 1 || records.length > MAX_BATCH || records.some(m =>
      !m || m.chatId !== chatId || !id(m.messageId) || typeof m.text !== 'string' || Buffer.byteLength(m.text) > 1024 * 1024)) invalid();
  }
  /** Ordered collector page. Cursor and required durable work commit together, with source/CAS checks. */
  commitBatch(input: { sourceGeneration: string; chatId: string; expectedCursor: string; messages: readonly StoredMessage[] }) {
    this.validate(input.chatId, input.messages);
    if (input.sourceGeneration !== this.sourceGeneration) throw new KakaoError('CURSOR_CONFLICT', 'Source generation changed; do not reuse an old cursor');
    if (!id(input.expectedCursor, true)) invalid();
    let previous = BigInt(input.expectedCursor);
    for (const row of input.messages) { if (BigInt(row.messageId) <= previous) invalid(); previous = BigInt(row.messageId); }
    return io(() => this.db.transaction(() => {
      if (this.cursor(input.chatId) !== input.expectedCursor) throw new KakaoError('CURSOR_CONFLICT', 'Collector cursor changed; reread the bounded batch');
      const counts = this.save(input.messages), cursor = input.messages.at(-1)!.messageId;
      const observed = this.observedHead(input.chatId), observedHead = BigInt(cursor) > BigInt(observed) ? cursor : observed;
      this.db.db.prepare(`INSERT INTO message_ingestion_cursors(chat_id,cursor,observed_head) VALUES(?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET cursor=excluded.cursor,observed_head=excluded.observed_head`).run(input.chatId, cursor, observedHead);
      return { ...counts, cursor, observedHead, hasMore: BigInt(cursor) < BigInt(observedHead), sourceGeneration: this.sourceGeneration };
    }, 'immediate'));
  }
  /** Live push/known-new sync: persist work plus observed head; never jump an ordered collector cursor. */
  ingest(message: StoredMessage) {
    this.validate(message.chatId, [message]);
    return io(() => this.db.transaction(() => {
      const counts = this.save([message]), checkpoint = this.checkpoint(message.chatId);
      const observedHead = BigInt(message.messageId) > BigInt(checkpoint.observed_head) ? message.messageId : checkpoint.observed_head;
      this.db.db.prepare(`INSERT INTO message_ingestion_cursors(chat_id,cursor,observed_head) VALUES(?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET observed_head=excluded.observed_head`).run(message.chatId, checkpoint.cursor, observedHead);
      return { ...counts, cursor: checkpoint.cursor, observedHead };
    }, 'immediate'));
  }
  /** Authorization is rechecked inside the transaction, before selection and LIMIT. */
  claim(input: { chatId: string; consumer: string; limit: number; leaseMs: number }, authorize: () => void): InboxClaim {
    if (!id(input.chatId) || typeof input.consumer !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,63}$/.test(input.consumer) ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 300000) invalid();
    return io(() => this.db.transaction(() => {
      authorize(); const now = this.now(), leaseUntil = now + input.leaseMs;
      const rows = this.db.db.prepare(`SELECT e.event_id,CAST(e.seq AS TEXT) AS sequence,e.message_id,e.attempts FROM message_inbox_events e
        WHERE e.chat_id=? AND ${AVAILABLE} AND ${VISIBLE} ORDER BY e.seq LIMIT ?`).all(input.chatId, now, input.limit + 1) as EventRow[];
      const events: InboxEvent[] = [];
      for (const row of rows.slice(0, input.limit)) {
        const leaseId = randomUUID();
        const changed = this.db.db.prepare(`UPDATE message_inbox_events SET state='leased',consumer=?,lease_id=?,lease_until=?,attempts=attempts+1
          WHERE event_id=? AND (state='pending' OR (state='leased' AND lease_until<=?))`).run(input.consumer, leaseId, leaseUntil, row.event_id, now).changes;
        if (changed !== 1) throw new KakaoError('LEASE_CONFLICT', 'Concurrent event claim changed');
        const message = this.store.getMessage(input.chatId, row.message_id);
        if (!message) throw new KakaoError('INTERNAL', 'Event lost its stored message');
        events.push({ eventId: row.event_id, sequence: row.sequence, messageId: row.message_id, leaseId, leaseUntil, attempts: row.attempts + 1, message });
      }
      authorize();
      return { sourceGeneration: this.sourceGeneration, events, hasMore: rows.length > input.limit };
    }, 'immediate'));
  }
  /** Only a matching unexpired lease can acknowledge; repeated acknowledgement is idempotent. */
  ack(input: { sourceGeneration: string; chatId: string; consumer: string; events: Array<{ eventId: string; leaseId: string }> }, authorize: () => void) {
    if (!id(input.chatId) || input.sourceGeneration !== this.sourceGeneration || typeof input.consumer !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,63}$/.test(input.consumer) ||
      !Array.isArray(input.events) || !input.events.length || input.events.length > 100 || new Set(input.events.map(e => e?.eventId)).size !== input.events.length ||
      input.events.some(e => !e || !uuid(e.eventId) || !uuid(e.leaseId) || Object.keys(e).some(k => !['eventId','leaseId'].includes(k)))) invalid();
    return io(() => this.db.transaction(() => {
      authorize(); let acknowledged = 0, alreadyAcknowledged = 0;
      for (const event of input.events) {
        const row = this.db.db.prepare(`SELECT state,consumer,lease_id,lease_until FROM message_inbox_events WHERE event_id=? AND chat_id=?`)
          .get(event.eventId, input.chatId) as { state: string; consumer: string; lease_id: string; lease_until: number } | undefined;
        if (!row || row.consumer !== input.consumer || row.lease_id !== event.leaseId) throw new KakaoError('LEASE_CONFLICT', 'Lease identity does not match');
        if (row.state === 'acked') { alreadyAcknowledged++; continue; }
        if (row.state !== 'leased' || row.lease_until <= this.now()) throw new KakaoError('LEASE_CONFLICT', 'Lease expired; claim again and process idempotently');
        this.db.db.prepare(`UPDATE message_inbox_events SET state='acked',acked_at=? WHERE event_id=?`).run(this.now(), event.eventId); acknowledged++;
      }
      authorize(); return { acknowledged, alreadyAcknowledged };
    }, 'immediate'));
  }
}
