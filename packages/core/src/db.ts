// ----------------------------------------------------------------------------
// The local account database: one SQLite file (~/.kakao-max/kakao.db, fallback ~/.kakao/kakao.db) holding
// messages, friends and known chats, opened with node:sqlite (no dependency).
//
// - Schema changes are numbered migrations recorded in `schema_migrations`;
//   add a new entry to MIGRATIONS, never edit an applied one.
// - The file is owner-only (0600) because it holds chat contents and contacts.
// - Legacy stores (messages.jsonl, friends.json, known-chats.json) are imported
//   once on first open, then renamed to `<name>.migrated-<timestamp>` so the
//   original data stays on disk as a backup.
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import { loadConfig } from './config.ts';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE messages (
        message_id  TEXT PRIMARY KEY,          -- LOCO logId, exactly as received
        log_num     INTEGER,                   -- numeric logId for range filters (NULL if not numeric)
        chat_id     TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        author_id   TEXT NOT NULL,
        author_name TEXT,
        type        INTEGER,
        text        TEXT NOT NULL,
        attachment  TEXT,
        send_at     INTEGER NOT NULL,
        raw         TEXT                       -- JSON
      );
      CREATE INDEX messages_chat_time ON messages (chat_id, send_at, log_num);

      CREATE TABLE friends (
        user_id TEXT PRIMARY KEY,
        data    TEXT NOT NULL                  -- JSON KakaoFriend
      );

      CREATE TABLE known_chats (
        id    TEXT PRIMARY KEY,
        type  TEXT NOT NULL DEFAULT '',
        title TEXT
      );

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      -- "Delete for me": KakaoTalk only hides a message on the current
      -- device. Rows stay in messages; ids listed here are left out of reads.
      -- Kept separate so a hide also applies to a message stored after it.
      CREATE TABLE hidden_messages (
        message_id TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        hidden_at  INTEGER NOT NULL            -- unix seconds
      );
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE agent_send_operations (
        request_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        room_digest TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempted_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('prepared','approved','sending','sent_unverified','send_unknown','expired','stale')),
        message_id TEXT,
        category TEXT NOT NULL CHECK (category IN ('notification','message-as-you'))
      );
      CREATE INDEX agent_send_attempts ON agent_send_operations (attempted_at, room_digest);
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE message_inbox_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acked')),
        consumer TEXT,
        lease_id TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        acked_at INTEGER,
        UNIQUE(chat_id, message_id)
      );
      CREATE INDEX message_inbox_claim ON message_inbox_events(chat_id,state,lease_until,seq);
      CREATE TABLE message_ingestion_cursors (
        chat_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        observed_head TEXT NOT NULL DEFAULT '0'
      );
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE agent_send_operations_v5 (
        request_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        room_digest TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempted_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('prepared','approved','sending','sent_unverified','send_unknown','expired','stale','applied_unverified','mutation_unknown')),
        message_id TEXT,
        category TEXT NOT NULL CHECK (category IN ('notification','message-as-you'))
      );
      INSERT INTO agent_send_operations_v5 SELECT * FROM agent_send_operations;
      DROP TABLE agent_send_operations;
      ALTER TABLE agent_send_operations_v5 RENAME TO agent_send_operations;
      CREATE INDEX agent_send_attempts ON agent_send_operations(attempted_at,room_digest);
    `
  },
  {
    // Signed local control operations (applied) and explicit human refusal (rejected).
    version: 6,
    sql: `
      CREATE TABLE agent_send_operations_v6 (
        request_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        room_digest TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempted_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('prepared','approved','sending','sent_unverified','send_unknown','expired','stale','applied_unverified','mutation_unknown','applied','rejected')),
        message_id TEXT,
        category TEXT NOT NULL CHECK (category IN ('notification','message-as-you'))
      );
      INSERT INTO agent_send_operations_v6 SELECT * FROM agent_send_operations;
      DROP TABLE agent_send_operations;
      ALTER TABLE agent_send_operations_v6 RENAME TO agent_send_operations;
      CREATE INDEX agent_send_attempts ON agent_send_operations(attempted_at,room_digest);
    `
  },
  {
    // Human passkey approvals: HMAC of the exact approval text only, never the draft or assertion.
    version: 7,
    sql: `
      CREATE TABLE agent_approvals (
        request_id TEXT PRIMARY KEY,
        envelope_digest TEXT NOT NULL,
        approver_id TEXT NOT NULL,
        verified_at INTEGER NOT NULL
      );
    `
  },
  {
    // Human-approved scoped grants: one-shot manual-room reads, and fixed-text standing sends.
    // Standing grants keep only HMACs of their approved texts.
    version: 8,
    sql: `
      CREATE TABLE read_grants (
        grant_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        tools TEXT NOT NULL,
        max_messages INTEGER NOT NULL,
        uses_left INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE standing_grants (
        grant_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        action TEXT NOT NULL,
        text_digests TEXT NOT NULL,
        max_per_day INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE standing_grant_uses (
        request_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        local_day TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX standing_grant_uses_day ON standing_grant_uses (grant_id, local_day);
    `
  },
  {
    // Room send permissions: rooms the person allowed once; later sends there skip per-message approval.
    version: 9,
    sql: `
      CREATE TABLE recipient_permissions (
        chat_id TEXT PRIMARY KEY,
        granted_at INTEGER NOT NULL,
        approver TEXT NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE recipient_permission_uses (
        request_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        local_day TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX recipient_permission_uses_day ON recipient_permission_uses (chat_id, local_day);
    `
  },
  {
    version: 10,
    sql: `
      DROP TABLE standing_grant_uses;
      DROP TABLE standing_grants;
      -- Old prepared work must be reviewed again after removing fixed-text approvals.
      UPDATE agent_send_operations SET state = 'stale' WHERE state IN ('prepared', 'approved');
    `
  },
  {
    version: 11,
    sql: `
      CREATE TABLE vault_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        media_type INTEGER NOT NULL,
        token TEXT NOT NULL,
        filename TEXT,
        filesize INTEGER,
        checksum TEXT,
        local_path TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX vault_media_chat_token ON vault_media (chat_id, token);
      CREATE INDEX vault_media_chat_msg ON vault_media (chat_id, message_id);
    `
  },
  {
    // Daily caps on account actions (add_friend): one row per approved attempt, no target ids.
    version: 12,
    sql: `
      CREATE TABLE account_action_uses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        local_day TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX account_action_uses_day ON account_action_uses (action, local_day);
    `
  }
];

export class KakaoDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private closed = false;

  private constructor(db: DatabaseSync, file: string) {
    this.db = db;
    this.path = file;
  }

  /**
   * Open (creating if needed) the database. `dir` defaults to KAKAO_DATA_DIR or
   * ~/.kakao-max (fallback ~/.kakao); legacy files in that directory are imported on first open.
   */
  static open(opts: { dir?: string; file?: string; importLegacy?: boolean } = {}): KakaoDb {
    const dir = opts.dir ?? (opts.file ? path.dirname(opts.file) : loadConfig().dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // the data dir holds chats, contacts and migration backups
    const file = opts.file ?? path.join(dir, 'kakao.db');
    const isNew = !fs.existsSync(file);
    if (isNew) fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);

    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const k = new KakaoDb(db, file);
    k.migrate();
    if (opts.importLegacy ?? true) importLegacyStores(k, dir);
    return k;
  }

  /** Run `fn` inside a transaction; rolls back if it throws. */
  transaction<T>(fn: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T {
    this.db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      });
    }
  }
}

const SQLITE_INT64_MAX = 9223372036854775807n;

/** Numeric logId for range queries, or null when the id is not a decimal integer. Clamped to SQLite int64 max. */
export function logNum(messageId: string): bigint | null {
  if (!/^\d{1,19}$/.test(messageId)) return null;
  const n = BigInt(messageId);
  return n <= SQLITE_INT64_MAX ? n : SQLITE_INT64_MAX;
}

// ---------------------------------------------------------------------------
// One-time import of the pre-SQLite file stores.
// ---------------------------------------------------------------------------

function importLegacyStores(k: KakaoDb, dir: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const legacy = [
    { file: 'messages.jsonl', run: importMessages },
    { file: 'friends.json', run: importFriends },
    { file: 'known-chats.json', run: importKnownChats }
  ];
  for (const { file, run } of legacy) {
    const src = path.join(dir, file);
    if (!fs.existsSync(src)) continue;
    const content = fs.readFileSync(src, 'utf8');
    const count = k.transaction(() => run(k, content));
    // Keep the original as a backup; never delete user data.
    const backup = `${src}.migrated-${stamp}`;
    fs.renameSync(src, backup);
    fs.chmodSync(backup, 0o600);
    process.stderr.write(`[db] imported ${count} rows from ${file} (original kept as ${path.basename(backup)})\n`);
  }
}

function importMessages(k: KakaoDb, content: string): number {
  const insert = k.db.prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, log_num, chat_id, seq, author_id, author_name, type, text, attachment, send_at, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // a torn final line from a crash; the rest is still valid
    }
    if (!m?.messageId || !m.chatId) continue;
    const id = String(m.messageId);
    const r = insert.run(
      id,
      logNum(id),
      String(m.chatId),
      Number(m.seq) || 0,
      String(m.authorId ?? ''),
      m.authorName ?? null,
      typeof m.type === 'number' ? m.type : null,
      String(m.text ?? ''),
      m.attachment == null ? null : typeof m.attachment === 'string' ? m.attachment : JSON.stringify(m.attachment),
      Number(m.sendAt) || 0,
      m.raw === undefined ? null : JSON.stringify(m.raw)
    );
    n += Number(r.changes);
  }
  return n;
}

function importFriends(k: KakaoDb, content: string): number {
  let arr: any[];
  try {
    arr = JSON.parse(content);
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  const insert = k.db.prepare('INSERT OR REPLACE INTO friends (user_id, data) VALUES (?, ?)');
  let n = 0;
  for (const f of arr) {
    if (!f?.userId) continue;
    delete f.phoneNumber; // never persisted (see friends.ts)
    insert.run(String(f.userId), JSON.stringify(f));
    n++;
  }
  return n;
}

function importKnownChats(k: KakaoDb, content: string): number {
  let arr: any[];
  try {
    arr = JSON.parse(content);
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  const insert = k.db.prepare('INSERT OR REPLACE INTO known_chats (id, type, title) VALUES (?, ?, ?)');
  let n = 0;
  for (const c of arr) {
    if (!c?.id) continue;
    insert.run(String(c.id), String(c.type ?? ''), c.title ?? null);
    n++;
  }
  return n;
}
