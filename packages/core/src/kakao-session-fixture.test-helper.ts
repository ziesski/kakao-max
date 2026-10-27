// KakaoSession with a fake LOCO session injected; the SQLite store is real (in a temp dir). All ids are made up.
// Shared by core's session tests and optional modules' tests.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Long, type ResilientLocoSession } from '@kakao-max/protocol';
import { KakaoSession } from './kakao-session.ts';
import { KakaoDb } from './db.ts';
import { MessageStore } from './message-store.ts';
import { KakaoError } from './errors.ts';
import { loadConfig } from './config.ts';

export const SELF = '123456789';
export const BSON_LONG = Long.fromString('9007199254740993');
export const CHAT = '987654321';

/** Records every LOCO call; each method answers with the next queued response for it. */
export class FakeLocoSession extends EventEmitter {
  calls: Array<{ method: string; args: unknown[] }> = [];
  replies: Record<string, unknown[]> = {};

  private answer(method: string, args: unknown[]): unknown {
    this.calls.push({ method, args });
    const queue = this.replies[method];
    if (!queue?.length && method === 'request' && args[0] === 'LCHATLIST') return { header: { status: 0 }, data: { chatDatas: [{ c: CHAT, n: 0, t: 'DirectChat' }] } };
    if (!queue?.length) throw new Error(`no reply queued for ${method}`);
    return queue.shift();
  }

  async sendText(...args: unknown[]) {
    return this.answer('sendText', args);
  }
  async sendReply(...args: unknown[]) {
    return this.answer('sendReply', args);
  }
  async uploadMedia(...args: unknown[]) {
    return this.answer('uploadMedia', args);
  }
  async markRead(...args: unknown[]) {
    return this.answer('markRead', args);
  }
  /** When set, CHATINFO/GETMEM answers with this; otherwise it fails. */
  meta?: { title: string; isGroup: boolean; members: Array<{ userId: string; name: string }> };
  async getChannelMeta(chatId: string) {
    if (!this.meta) throw new Error('CHATINFO not available in this test');
    return { chatId, raw: {}, ...structuredClone(this.meta) };
  }
  async getMembers(...args: unknown[]) {
    return this.answer('getMembers', args);
  }
  async syncBlockList(...args: unknown[]) {
    return this.answer('syncBlockList', args);
  }
  async getBlockMembers(...args: unknown[]) {
    return this.answer('getBlockMembers', args);
  }
  async addBlockItem(...args: unknown[]) {
    return this.answer('addBlockItem', args);
  }
  async deleteBlockItem(...args: unknown[]) {
    return this.answer('deleteBlockItem', args);
  }
  async modifyMessage(...args: unknown[]) {
    return this.answer('modifyMessage', args);
  }
  async sendEmoticonRaw(...args: unknown[]) {
    return this.answer('sendEmoticonRaw', args);
  }
  async downloadMedia(...args: unknown[]) { return this.answer('downloadMedia', args); }
  async chatLogs(...args: unknown[]) {
    return this.answer('chatLogs', args);
  }
  async deleteMessage(...args: unknown[]) {
    return this.answer('deleteMessage', args);
  }
  async leave(...args: unknown[]) {
    return this.answer('leave', args);
  }
  async request(...args: unknown[]) {
    return this.answer('request', args);
  }
  close() {}

  connect() {
    this.emit('connected', { endpoint: { host: 'loco.test', port: 443 }, loginList: { conversations: [], raw: {} } });
  }
}

const testSessions = new WeakMap<KakaoSession, FakeLocoSession>();
export function phoneRead(kakao: KakaoSession) {
  testSessions.get(kakao)!.emit('connected', { endpoint: { host: 'loco.test', port: 443 },
    loginList: { conversations: [{ id: CHAT, type: 'DirectChat', unreadCount: 0, raw: { l: { logId: new MessageStore(KakaoDb.open({ dir: kakao.config.dataDir })).getNewestLogId(CHAT) ?? '0' } } }], raw: {} } });
}
export async function readRecent(kakao: KakaoSession, since = 0, chatId = CHAT) {
  phoneRead(kakao); return kakao.recentMessages(since, chatId);
}
export async function readSearch(kakao: KakaoSession, query: string, opts: { chatId?: string } = {}) {
  phoneRead(kakao); return kakao.searchMessages(query, opts);
}
export async function readHistory(kakao: KakaoSession, chatId: string, opts: { limit?: number } = {}) {
  phoneRead(kakao); return kakao.getHistory(chatId, opts);
}
export async function readWait(kakao: KakaoSession, since: number, timeout: number, chatId: string) {
  phoneRead(kakao); return kakao.waitForMessages(since, timeout, chatId);
}

export function setup(extraEnv: Record<string, string> = {}, friends: Array<{ userId: string; nickName: string; type?: number }> = [], grantAccess = true, log?: (line: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-session-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, `KAKAO_USER_ID=${SELF}\nKAKAO_ACCESS_TOKEN=fake-token\nKAKAO_REGISTERED_DEVICE_UUID=fake-uuid\n`);
  const config = loadConfig({ envPath, env: { KAKAO_DATA_DIR: path.join(dir, 'data'), ...extraEnv } });
  if (friends.length) {
    const insert = KakaoDb.open({ dir: config.dataDir }).db.prepare('INSERT INTO friends (user_id, data) VALUES (?, ?)');
    for (const f of friends) insert.run(f.userId, JSON.stringify(f));
  }
  const fake = new FakeLocoSession();
  const kakao = new KakaoSession(config, { session: fake as unknown as ResilientLocoSession, log });
  if (grantAccess) kakao.setRoomAccess(CHAT, { mode: 'immediate', maxMessages: 100, callsPerHour: 3600 });
  testSessions.set(kakao, fake);
  const stored = () => new MessageStore(KakaoDb.open({ dir: config.dataDir })).getMessages(CHAT, { limit: 50 });
  return { kakao, fake, stored, dir };
}

export const isCode = (code: string) => (e: unknown) => e instanceof KakaoError && e.code === code;
