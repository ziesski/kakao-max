// ----------------------------------------------------------------------------
// Real KakaoTalk Friends Manager.
//
// Fetches the complete address book / friends list from
// https://katalk.kakao.com/mac/friends/update.json using authenticated
// HTTP calls (Authorization: <accessToken>-<deviceUUID>), caches locally
// in the `friends` table of KakaoDb, and supports querying / resolving friends by
// userId, nickname, or custom friendNickName.
//
// Phone numbers from the API are deliberately dropped: they are third-party PII,
// never needed to address a friend (userId is), and would otherwise flow into
// every agent context via list_friends.
// ----------------------------------------------------------------------------

import type { KakaoDb } from './db.ts';
import type { KakaoConfig } from './config.ts';
import { wasRequest } from './was-http.ts';

export interface KakaoFriend {
  userId: string;
  accountId?: string;
  nickName: string;
  friendNickName?: string;
  statusMessage?: string;
  profileImageUrl?: string;
  fullProfileImageUrl?: string;
  originalProfileImageUrl?: string;
  favorite?: boolean;
  hidden?: boolean;
  userType?: number;
  type?: number;
  /** Address-book type before a local block, restored on unblock. */
  typeBeforeBlock?: number;
}

/** Map a WAS friend record (update.json / add.json) to KakaoFriend. Phone numbers are dropped (see header). */
function toFriend(f: any, fallbackUserId?: string): KakaoFriend {
  return {
    userId: String(f.userId || fallbackUserId),
    accountId: f.accountId != null ? String(f.accountId) : undefined,
    nickName: f.nickName || '',
    friendNickName: f.friendNickName || undefined,
    statusMessage: f.statusMessage || undefined,
    profileImageUrl: f.profileImageUrl || undefined,
    fullProfileImageUrl: f.fullProfileImageUrl || undefined,
    originalProfileImageUrl: f.originalProfileImageUrl || undefined,
    favorite: f.favorite === true,
    hidden: f.hidden === true,
    userType: typeof f.userType === 'number' ? f.userType : undefined,
    type: typeof f.type === 'number' ? f.type : undefined
  };
}

export class FriendsStore {
  private friends = new Map<string, KakaoFriend>();
  private readonly kdb: KakaoDb;
  private readonly client: KakaoConfig['client'];
  private lastSync = 0;

  constructor(kdb: KakaoDb, client: KakaoConfig['client'] = { appVersion: '26.4.0', os: 'mac', lang: 'ko', timeZone: 'Asia/Seoul' }) {
    this.kdb = kdb;
    this.client = client;
    // ~1k rows: kept in memory for scored search, persisted write-through.
    const rows = kdb.db.prepare('SELECT data FROM friends').all() as Array<{ data: string }>;
    for (const r of rows) {
      const f = JSON.parse(r.data) as KakaoFriend;
      if (f.userId) this.friends.set(String(f.userId), f);
    }
  }

  private saveToCache(): void {
    const upsert = this.kdb.db.prepare('INSERT OR REPLACE INTO friends (user_id, data) VALUES (?, ?)');
    this.kdb.transaction(() => {
      for (const f of this.friends.values()) upsert.run(f.userId, JSON.stringify(f));
    });
  }

  /**
   * Synchronize the full friends list from KakaoTalk WAS server. Throws KakaoError
   * (NETWORK / AUTH_EXPIRED / LOCO_STATUS) on failure; the cached list stays usable.
   */
  async sync(creds: { accessToken: string; deviceUUID: string }, force = false): Promise<number> {
    const now = Date.now();
    // Cache for 5 minutes unless forced
    if (!force && this.friends.size > 0 && now - this.lastSync < 300_000) {
      return this.friends.size;
    }

    const data = await wasRequest(this.client, creds, 'friends/update.json', { form: { token: '0' } });
    const rawFriends: any[] = Array.isArray(data.friends) ? data.friends : [];
    for (const f of rawFriends) {
      const friend = toFriend(f);
      this.friends.set(friend.userId, friend);
    }

    this.lastSync = now;
    this.saveToCache();
    return this.friends.size;
  }

  /**
   * Search users on KakaoTalk server by query (name, KakaoTalk ID, or phone).
   * Calls GET /mac/friends/search.json?query=...
   */
  async searchRemote(creds: { accessToken: string; deviceUUID: string }, query: string): Promise<Record<string, any>> {
    return wasRequest(this.client, creds, 'friends/search.json', { query: { query } });
  }

  /**
   * Add a friend by userId on KakaoTalk server.
   * Calls POST /mac/friends/add.json with id=<userId>.
   */
  async add(creds: { accessToken: string; deviceUUID: string }, userId: string): Promise<Record<string, any>> {
    const data = await wasRequest(this.client, creds, 'friends/add.json', { form: { id: userId } });
    if (data.friend) {
      const friend = toFriend(data.friend, userId);
      this.friends.set(friend.userId, friend);
      this.saveToCache();
    }
    return data;
  }

  /**
   * Search friends by query string (matching nickName, friendNickName, or statusMessage).
   */
  search(query?: string, limit = 50): KakaoFriend[] {
    const all = Array.from(this.friends.values());
    if (!query || !query.trim()) {
      return all
        .sort((a, b) => {
          if (Boolean(a.favorite) !== Boolean(b.favorite)) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
          const nameA = a.friendNickName || a.nickName || '';
          const nameB = b.friendNickName || b.nickName || '';
          return nameA.localeCompare(nameB, 'ko', { sensitivity: 'base' });
        })
        .slice(0, limit);
    }
    const q = query.trim().toLowerCase();
    const matches: { friend: KakaoFriend; score: number }[] = [];

    for (const f of all) {
      const nick = (f.nickName || '').toLowerCase();
      const fnick = (f.friendNickName || '').toLowerCase();
      const status = (f.statusMessage || '').toLowerCase();
      const uid = f.userId;

      if (uid === q) {
        matches.push({ friend: f, score: 100 });
      } else if (fnick === q || nick === q) {
        matches.push({ friend: f, score: 90 });
      } else if (fnick.startsWith(q) || nick.startsWith(q)) {
        matches.push({ friend: f, score: 80 });
      } else if (fnick.includes(q) || nick.includes(q)) {
        matches.push({ friend: f, score: 70 });
      } else if (status.includes(q)) {
        matches.push({ friend: f, score: 50 });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit).map((m) => m.friend);
  }

  /**
   * Find a single friend by userId or name query.
   */
  find(queryOrUserId: string): KakaoFriend | undefined {
    const trimmed = queryOrUserId.trim();
    if (this.friends.has(trimmed)) return this.friends.get(trimmed);

    const matches = this.search(trimmed, 1);
    return matches[0];
  }

  /**
   * List all blocked friends (type === 9).
   */
  listBlocked(): KakaoFriend[] {
    return Array.from(this.friends.values()).filter((f) => f.type === 9);
  }

  /**
   * Update blocked status locally in memory and cache. Unblocking restores the type the
   * entry had before it was blocked here; when that is unknown (it was already blocked in
   * the server's address book) the type is cleared and the next sync refetches it, rather
   * than guessing that the person is a friend.
   */
  setBlocked(userId: string, blocked: boolean): void {
    const f = this.friends.get(String(userId));
    if (!f) return;
    if (blocked) {
      if (f.type !== 9) f.typeBeforeBlock = f.type;
      f.type = 9;
    } else if (f.type === 9) {
      f.type = f.typeBeforeBlock;
      delete f.typeBeforeBlock;
      if (f.type === undefined) this.lastSync = 0;
    }
    this.saveToCache();
  }

  get(userId: string): KakaoFriend | undefined {
    return this.friends.get(String(userId));
  }

  get size(): number {
    return this.friends.size;
  }
}
