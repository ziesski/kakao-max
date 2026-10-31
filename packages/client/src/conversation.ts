import { randomUUID } from 'node:crypto';
import type { ConversationReader, ConversationRoom, ConversationMessage } from './types.ts';
import { CONVERSATION_LIMITS } from './types.ts';
import { ConversationError } from './types.ts';

export type WriteResult = { ok: true; messageId: string } | { ok: false; code: string; message: string; uncertain: boolean };
export interface MessageWriter { identity(): Promise<{ connected: boolean; userId?: string }>; send(chatId: string, text: string, requestId: string): Promise<WriteResult>; }
const validId = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v);
const ordered = (a: ConversationMessage, b: ConversationMessage) => BigInt(a.messageId) < BigInt(b.messageId) ? -1 : BigInt(a.messageId) > BigInt(b.messageId) ? 1 : 0;
const equal = (a: ConversationMessage, b: ConversationMessage) => a.messageId === b.messageId && a.authorId === b.authorId && a.authorName === b.authorName && a.type === b.type && a.text === b.text && a.sendAt === b.sendAt;

/** UI-independent room lifecycle, bounded cache and write state. Neither the terminal nor a command parser owns these rules. */
export class Conversation {
  readonly reader: ConversationReader;
  readonly writer: MessageWriter;
  private _rooms: ConversationRoom[] = [];
  private _active?: ConversationRoom;
  private requestedRoomId?: string;
  private _messages: ConversationMessage[] = [];
  private _connected = false;
  private _userId?: string;
  private _live = false;
  private _mode?: 'ask' | 'trust';
  private cursor = 0;
  get mode(): 'ask' | 'trust' | undefined { return this._mode; }
  private _readError?: unknown;
  private _pending?: { chatId: string; text: string; requestId: string; uncertain: boolean };
  get pending(): Readonly<{ chatId: string; text: string; requestId: string; uncertain: boolean }> | undefined { return this._pending; }
  get rooms(): readonly Readonly<ConversationRoom>[] { return this._rooms; }
  get active(): Readonly<ConversationRoom> | undefined { return this._active; }
  get messages(): readonly Readonly<ConversationMessage>[] { return this._messages; }
  get connected(): boolean { return this._connected; }
  get userId(): string | undefined { return this._userId; }
  get live(): boolean { return this._live; }
  get readError(): unknown { return this._readError; }
  private generation = 0;
  private pollRequest?: { generation: number; promise: Promise<void> };
  private closed = false;
  private unwatch?: () => void;
  private dirty = false;
  private draining = false;
  private stopWatch(): void { this.unwatch?.(); this.unwatch = undefined; this.dirty = false; }
  stopUpdates(): void { this.stopWatch(); this._live = false; }
  disconnected(error: Error): void { this.failRead(error); }
  private queueUpdate(generation: number): void {
    if (generation !== this.generation || this.closed || !this._live) return;
    this.dirty = true;
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      try {
        while (this.dirty && generation === this.generation && this._live && !this.closed) {
          this.dirty = false;
          try { await this.poll(); } catch { break; }
        }
      } finally { this.draining = false; if (this.dirty && this._live && !this.closed) this.queueUpdate(this.generation); }
    })();
  }
  private async startWatch(generation: number): Promise<void> {
    if (!this._active || !this.reader.watch || !this.watchAllowed()) return;
    const stop = await this.reader.watch(this._active.id, () => this.queueUpdate(generation), error => {
      if (generation === this.generation && !this.closed) this.failRead(error);
    });
    if (generation !== this.generation || this.closed || !this._live) { stop(); return; }
    this.unwatch = stop;
    // One catch-up after subscribing closes the history/subscribe race; never an idle timer.
    this.queueUpdate(generation);
  }

  private readonly watchAllowed: () => boolean;
  private readonly canOpen: (room: ConversationRoom) => boolean;
  private readonly changed: () => void;

  constructor(reader: ConversationReader, writer: MessageWriter, changed: () => void, canOpen: (room: ConversationRoom) => boolean = () => true, watchAllowed: () => boolean = () => true) {
    this.reader = reader; this.writer = writer; this.changed = changed; this.canOpen = canOpen; this.watchAllowed = watchAllowed;
  }
  async start(): Promise<void> {
    const [status, writer] = await Promise.all([this.reader.status(), this.writer.identity()]);
    if (!status.connected || !writer.connected) throw new ConversationError('NOT_CONNECTED', '카카오톡 연결이 끊겨 있습니다.');
    if (!validId(status.userId) || writer.userId !== status.userId) { const error = new ConversationError('ACCOUNT_MISMATCH', '조회와 전송 연결의 계정이 일치하지 않습니다. 연결 설정을 확인하세요.'); this.failRead(error); throw error; }
    if (this.closed) return;
    if (this._userId && status.userId !== this._userId) { const error = new ConversationError('ACCOUNT_MISMATCH', '계정이 변경되었습니다. 새 화면에서 다시 연결하세요.'); this.failRead(error); throw error; }
    this._connected = true; this._userId = status.userId; this._mode = status.mode;
    await this.refreshRooms();
  }
  async refreshRooms(): Promise<void> {
    if (!this._connected || this.closed) throw new ConversationError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    const rooms = await this.reader.rooms();
    if (!this.closed) { this._rooms = rooms.map(r => ({ ...r })); this.changed(); }
  }
  async open(roomId: string): Promise<void> {
    if (!this._connected || this.closed) throw new ConversationError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    this.stopWatch();
    const generation = ++this.generation;
    this.requestedRoomId = undefined;
    this._active = undefined; this._messages = []; this._live = false; this._readError = undefined; this.changed();
    const room = this._rooms.find(r => r.id === roomId);
    if (!room || !this.canOpen(room)) throw new ConversationError('ROOM_NOT_AVAILABLE', '이 화면에서 열 수 없는 방입니다.');
    this.requestedRoomId = room.id;
    try {
      const result = await this.reader.history(room.id);
      if (this.closed || generation !== this.generation) return;
      this.cursor = result.cursor ?? 0; this._active = room; this.merge(result.messages, [], true); this._live = true; this.changed();
      await this.startWatch(generation);
    } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
  }
  async refresh(): Promise<void> {
    if (!this._connected || this.closed) throw new ConversationError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    if (!this._active) {
      if (this.requestedRoomId) await this.open(this.requestedRoomId);
      else await this.refreshRooms();
      return;
    }
    this.stopWatch();
    const roomId = this._active.id, generation = ++this.generation;
    try {
      const result = await this.reader.history(roomId);
      if (this.closed || generation !== this.generation) return;
      this.cursor = result.cursor ?? 0; this.merge(result.messages, [], true); this._live = true; this._readError = undefined; this.changed();
      await this.startWatch(generation);
    } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
  }
  async poll(): Promise<void> {
    if (!this._active || !this._live || this.closed) return;
    const roomId = this._active.id, generation = this.generation;
    if (this.pollRequest?.generation === generation) return this.pollRequest.promise;
    const visible = this._messages.map(m => m.messageId), after = visible.at(-1) ?? '0';
    const promise = (async () => {
      try {
        const result = await this.reader.updates(roomId, after, visible, this.cursor);
        if (this.closed || generation !== this.generation) return;
        this.merge(result.messages, result.removedIds, result.reset);
        this.cursor = result.cursor ?? this.cursor;
        if (result.more) this.dirty = true;
      } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
    })();
    this.pollRequest = { generation, promise };
    try { await promise; } finally { if (this.pollRequest?.promise === promise) this.pollRequest = undefined; }
  }
  private failRead(error: unknown): void {
    this.stopWatch();
    this._live = false;
    const code = (error as { code?: unknown })?.code;
    // Keep the last authorized view on transport/budget failures. Permission,
    // identity and malformed-response failures still discard displayed content.
    if (!['RATE_LIMITED', 'NETWORK', 'TIMEOUT', 'NOT_CONNECTED'].includes(String(code))) this._messages = [];
    this._readError = error; this.changed();
  }
  private merge(incoming: ConversationMessage[], removed: string[], reset: boolean): void {
    if (!Array.isArray(incoming) || incoming.some(m => !validId(m.messageId) || !validId(m.authorId)) || !Array.isArray(removed)) {
      throw new ConversationError('INVALID_RESPONSE', '대화 응답 형식이 올바르지 않습니다.');
    }
    const map = new Map((reset ? [] : this._messages).map(m => [m.messageId, m]));
    for (const id of removed) map.delete(id);
    for (const m of incoming) map.set(m.messageId, { ...m });
    const next = [...map.values()].sort(ordered).slice(-CONVERSATION_LIMITS.visible);
    if (next.length !== this._messages.length || next.some((m, i) => !equal(m, this._messages[i]))) {
      this._messages = next; this.changed();
    }
  }
  async send(text: string): Promise<void> {
    const room = this._active;
    if (!room || !this.canOpen(room)) throw new ConversationError('ROOM_NOT_AVAILABLE', '먼저 방을 선택하세요.');
    if (this._pending) throw new ConversationError('SEND_PENDING', '앞선 전송 결과를 먼저 확인하세요. 새 요청으로 다시 보내지 않습니다.');
    const generation = this.generation;
    const identity = await this.writer.identity();
    if (this.closed || generation !== this.generation || this._active?.id !== room.id) throw new ConversationError('ROOM_NOT_AVAILABLE', '방이 변경되었습니다. 전송할 방을 다시 확인하세요.');
    if (this._pending) throw new ConversationError('SEND_PENDING', '앞선 전송 결과를 먼저 확인하세요.');
    if (!identity.connected) throw new ConversationError('NOT_CONNECTED', '전송 연결이 끊겼습니다.');
    if (identity.userId !== this._userId) throw new ConversationError('ACCOUNT_MISMATCH', '전송 계정이 달라졌습니다. 연결 설정을 확인하세요.');
    const request = { chatId: room.id, text, requestId: randomUUID(), uncertain: false };
    this._pending = request;
    let result: WriteResult;
    try { result = await this.writer.send(room.id, text, request.requestId); }
    catch { result = { ok: false, code: 'SEND_OUTCOME_UNKNOWN', message: '전송 결과가 불확실합니다. 카카오톡에서 확인하고 새 요청으로 다시 보내지 마세요.', uncertain: true }; }
    if (!result.ok) {
      if (result.uncertain || result.code === 'APPROVAL_REQUIRED') request.uncertain = result.uncertain;
      else this._pending = undefined;
      this.changed(); throw new ConversationError(result.code, result.message);
    }
    if (!validId(result.messageId)) { request.uncertain = true; throw new ConversationError('SEND_OUTCOME_UNKNOWN', '전송 응답을 확인할 수 없습니다. 새 요청으로 다시 보내지 마세요.'); }
    this._pending = undefined;
    if (!this.closed && this._active?.id === request.chatId && this._userId) {
      this.merge([{ messageId: result.messageId, authorId: this._userId, text, type: 1, sendAt: Date.now() / 1000 }], [], false);
    }
    this.changed();
  }
  close(): void { this.stopWatch(); this.closed = true; this.generation++; this._active = undefined; this.requestedRoomId = undefined; this._messages = []; this._rooms = []; this._userId = undefined; this._connected = false; this._live = false; }
}
