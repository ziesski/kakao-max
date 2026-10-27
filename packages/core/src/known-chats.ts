// ----------------------------------------------------------------------------
// Chats the daemon has seen that LOGINLIST may not return on the next login.
//
// LOGINLIST only returns recently-active chats, so a 1:1 opened via LOCO CREATE,
// or a chat whose first message arrived as a push, disappears from list_chats on
// restart. We remember those chat ids (plus type/title) in the `known_chats`
// table of KakaoDb and re-add them after every login.
// ----------------------------------------------------------------------------

import type { KakaoDb } from './db.ts';

export interface KnownChat {
  id: string;
  type: string;
  title?: string;
}

export class KnownChats {
  private readonly kdb: KakaoDb;
  private readonly chats = new Map<string, KnownChat>();

  constructor(kdb: KakaoDb) {
    this.kdb = kdb;
    const rows = kdb.db.prepare('SELECT id, type, title FROM known_chats ORDER BY rowid').all() as Array<{
      id: string;
      type: string;
      title: string | null;
    }>;
    for (const r of rows) this.chats.set(r.id, { id: r.id, type: r.type, ...(r.title != null ? { title: r.title } : {}) });
  }

  list(): KnownChat[] {
    return [...this.chats.values()];
  }

  /** Remember (or update) a chat; writes only when something changed. */
  remember(chat: KnownChat): void {
    const prev = this.chats.get(chat.id);
    const next: KnownChat = { id: chat.id, type: chat.type || prev?.type || '' };
    const title = chat.title || prev?.title;
    if (title) next.title = title;
    if (prev && prev.type === next.type && prev.title === next.title) return;
    this.chats.set(chat.id, next);
    this.kdb.db
      .prepare('INSERT INTO known_chats (id, type, title) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title')
      .run(next.id, next.type, next.title ?? null);
  }
}
