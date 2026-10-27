// ----------------------------------------------------------------------------
// History backfill for get_history.
//
// The source answers a (cur, max] window, oldest first, `count` per page, with
// `hasMore`/`lastTokenId` for paging. The daemon backs it with MCHATLOGS
// (mchatLogsSource below): SYNCMSG only returned each chat's latest logs, while
// MCHATLOGS pages through everything the server keeps for this device, which is
// every log since this device key was registered.
// When the local MessageStore has fewer messages than requested (e.g. a 1:1 room opened
// via CREATE, or a chat never seen live), page from cur=0 up to `max`; otherwise only
// fetch the gap after the newest stored log. Every fetched log is a real server log —
// nothing is synthesized — and is persisted via MessageStore.saveMessage (dedupe on
// messageId). Uses the daemon's existing LOCO session; never opens a second connection.
// ----------------------------------------------------------------------------

import type { IncomingMessage, SyncResult } from '@kakao-max/protocol';
import type { MessageStore, StoredMessage } from './message-store.ts';

export interface SyncSource {
  syncMessages(
    chatId: string,
    opts: { cur?: string | number; max?: string | number; count?: number }
  ): Promise<SyncResult>;
}

export interface BackfillReport {
  /** 'full' = paged from cur=0 (or the caller's `cur`); 'gap' = from the newest stored log; 'skipped' = no SYNCMSG sent. */
  mode: 'full' | 'gap' | 'skipped';
  reason?: string;
  max: string;
  cur: string;
  nextCur?: string;
  pages: number;
  fetched: number;
  inserted: number;
  /** Status of the last SYNCMSG page (0 = ok; -203 = empty (cur, max] range). */
  status?: number;
  hasMore?: boolean;
  error?: string;
}

const isPositiveLogId = (v: string | undefined): v is string => {
  if (!v) return false;
  try {
    return BigInt(v) > 0n;
  } catch {
    return false;
  }
};

const maxId = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);

export async function backfillHistory(
  deps: {
    source: SyncSource;
    beforePage?: () => Promise<void>;
    afterPage?: () => void;
    store: MessageStore;
    /** Optional enrichment (author names) applied before persisting. */
    decorate?: (m: IncomingMessage) => IncomingMessage & { authorName?: string };
    /** Atomic persistence override for live ingestion and its durable work. */
    persist?: (m: StoredMessage) => boolean;
    /** Optional post-commit notification called when a new message is inserted. */
    onMessage?: (m: StoredMessage) => void;
  },
  chatId: string,
  opts: { max?: string; limit: number; pageSize?: number; maxPages?: number; cur?: string }
): Promise<BackfillReport> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const maxPages = Math.max(opts.maxPages ?? 20, 1);
  const report: BackfillReport = { mode: 'skipped', max: opts.max ?? '0', cur: '0', pages: 0, fetched: 0, inserted: 0 };

  if (opts.max != null && !isPositiveLogId(opts.max)) {
    // Caller explicitly provided max=0 or non-positive; nothing to fetch.
    report.reason = 'no known last log id for this chat (max=0)';
    return report;
  }
  const max = isPositiveLogId(opts.max) ? opts.max : undefined;
  const maxBig = max ? BigInt(max) : undefined;
  const SQLITE_INT64_MAX = 9223372036854775807n;
  const beforeLogId = maxBig && maxBig < SQLITE_INT64_MAX ? (maxBig + 1n).toString() : undefined;

  const stored = deps.store.getMessages(chatId, {
    limit: Number.MAX_SAFE_INTEGER,
    beforeLogId,
    includeHidden: true, // hidden rows are still stored; they must not look like gaps to refetch
    includeDeleted: true // deleted rows are still on server; they must not look like gaps to refetch
  });
  const newestStored = stored.reduce<string | undefined>((acc, m) => {
    if (!isPositiveLogId(m.messageId)) return acc;
    return acc ? maxId(acc, m.messageId) : m.messageId;
  }, undefined);

  let cur = '0';
  if (opts.cur === '0' || isPositiveLogId(opts.cur)) {
    // Caller-chosen lower bound: page (cur, max] regardless of what's stored.
    report.mode = 'full';
    cur = opts.cur;
  } else if (stored.length >= opts.limit && newestStored) {
    if (max && BigInt(newestStored) >= BigInt(max)) {
      report.mode = 'skipped';
      report.reason = 'local store already covers this chat up to max';
      return report;
    }
    // When max is omitted or newestStored < max, check for newer logs starting from newestStored.
    report.mode = 'gap';
    cur = newestStored;
  } else {
    report.mode = 'full';
  }
  report.cur = cur;
  report.max = max ?? newestStored ?? '0';

  for (let page = 0; page < maxPages; page++) {
    await deps.beforePage?.();
    let res: SyncResult;
    try {
      res = await deps.source.syncMessages(chatId, { cur, max, count: pageSize });
    } catch (err) {
      report.error = (err as Error).message;
      break;
    }
    deps.afterPage?.();
    report.pages++;
    report.status = res.status;
    report.hasMore = res.hasMore;
    if (res.status !== 0 || res.messages.length === 0) break;
    report.fetched += res.messages.length;
    for (const raw of res.messages) {
      if (!raw.messageId) continue;
      if (raw.chatId && String(raw.chatId) !== String(chatId)) continue;
      const m: IncomingMessage & { authorName?: string } = deps.decorate ? deps.decorate(raw) : raw;
      const row: StoredMessage = {
        seq: 0,
        chatId: String(chatId),
        messageId: String(m.messageId),
        authorId: String(m.authorId || ''),
        authorName: m.authorName,
        type: m.type ?? 0,
        text: m.text || '',
        attachment: m.attachment as StoredMessage['attachment'],
        sendAt: m.sendAt ?? 0,
        raw: m.raw
      };
      if (deps.persist ? deps.persist(row) : deps.store.saveReceivedMessage(row)) {
        report.inserted++;
        if (deps.onMessage) deps.onMessage(row);
      }
      if (!max && isPositiveLogId(row.messageId)) {
        report.max = report.max === '0' ? row.messageId : maxId(report.max, row.messageId);
      }
    }
    const nextCur =
      res.raw?.lastTokenId != null ? String(res.raw.lastTokenId) : res.messages[res.messages.length - 1].messageId;
    if (!nextCur || nextCur === cur) break; // no forward progress
    cur = nextCur;
    report.nextCur = cur;
    if (!res.hasMore) break;
  }
  return report;
}

/** The one LOCO call mchatLogsSource needs (ResilientLocoSession.chatLogs). */
export interface ChatLogsSession {
  chatLogs(chatIds: (string | number)[], sinces: (string | number)[]): Promise<SyncResult & { eof: boolean }>;
}

/**
 * A SyncSource over MCHATLOGS. MCHATLOGS returns up to 80 logs after `since` with no upper
 * bound, so this keeps the (cur, max] window: logs above `max` are dropped, a page is cut to
 * `count`, and `hasMore` is set only when nothing was cut by `max` and the server is not at eof.
 */
export function mchatLogsSource(session: ChatLogsSession): SyncSource {
  return {
    async syncMessages(chatId, o) {
      const cur = String(o.cur ?? 0);
      const max = o.max != null && String(o.max) !== '0' ? BigInt(String(o.max)) : undefined;
      const res = await session.chatLogs([chatId], [cur]);
      const inWindow = max == null ? res.messages : res.messages.filter((m) => !m.messageId || BigInt(m.messageId) <= max);
      const page = inWindow.slice(0, Math.max(o.count ?? inWindow.length, 1));
      const cut = page.length < res.messages.length;
      const last = page[page.length - 1]?.messageId;
      return {
        status: res.status,
        messages: page,
        hasMore: page.length < inWindow.length || (!cut && !res.eof),
        raw: { ...res.raw, ...(last ? { lastTokenId: last } : {}) }
      };
    }
  };
}
