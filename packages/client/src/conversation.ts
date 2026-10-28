import { randomUUID } from 'node:crypto';
import type { UserReader, UserRoom, UserMessage } from '@kakao-max/core';
import { USER_READ_LIMITS } from '@kakao-max/core/user-read';
import { UserReadError } from './user-client.ts';

export type WriteResult = { ok: true; messageId: string } | { ok: false; code: string; message: string; uncertain: boolean };
export interface MessageWriter { identity(): Promise<{ connected: boolean; userId?: string }>; send(chatId: string, text: string, requestId: string): Promise<WriteResult>; }
const validId = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v);
const ordered = (a: UserMessage, b: UserMessage) => BigInt(a.messageId) < BigInt(b.messageId) ? -1 : BigInt(a.messageId) > BigInt(b.messageId) ? 1 : 0;
const equal = (a: UserMessage, b: UserMessage) => a.messageId === b.messageId && a.authorId === b.authorId && a.authorName === b.authorName && a.type === b.type && a.text === b.text && a.sendAt === b.sendAt;

/** UI-independent room lifecycle, bounded cache and write state. Neither the terminal nor a command parser owns these rules. */
export class Conversation {
  readonly reader: UserReader;
  readonly writer: MessageWriter;
  private _rooms: UserRoom[] = [];
  private _active?: UserRoom;
  private _messages: UserMessage[] = [];
  private _connected = false;
  private _userId?: string;
  private _live = false;
  private _readError?: unknown;
  private _pending?: { chatId: string; text: string; requestId: string; uncertain: boolean };
  get pending(): Readonly<{ chatId: string; text: string; requestId: string; uncertain: boolean }> | undefined { return this._pending; }
  get rooms(): readonly Readonly<UserRoom>[] { return this._rooms; }
  get active(): Readonly<UserRoom> | undefined { return this._active; }
  get messages(): readonly Readonly<UserMessage>[] { return this._messages; }
  get connected(): boolean { return this._connected; }
  get userId(): string | undefined { return this._userId; }
  get live(): boolean { return this._live; }
  get readError(): unknown { return this._readError; }
  private generation = 0;
  private pollRequest?: { generation: number; promise: Promise<void> };
  private closed = false;
  private readonly canOpen: (room: UserRoom) => boolean;
  private readonly changed: () => void;

  constructor(reader: UserReader, writer: MessageWriter, changed: () => void, canOpen: (room: UserRoom) => boolean = () => true) {
    this.reader = reader; this.writer = writer; this.changed = changed; this.canOpen = canOpen;
  }
  async start(): Promise<void> {
    const [status, writer] = await Promise.all([this.reader.status(), this.writer.identity()]);
    if (!status.connected || !writer.connected) throw new UserReadError('NOT_CONNECTED', '카카오톡 연결이 끊겨 있습니다.');
    if (!validId(status.userId) || writer.userId !== status.userId) throw new UserReadError('ACCOUNT_MISMATCH', '조회와 전송 연결의 계정이 일치하지 않습니다. 연결 설정을 확인하세요.');
    if (this.closed) return;
    if (this._userId && status.userId !== this._userId) throw new UserReadError('ACCOUNT_MISMATCH', '계정이 변경되었습니다. 새 화면에서 다시 연결하세요.');
    this._connected = true; this._userId = status.userId;
    await this.refreshRooms();
  }
  async refreshRooms(): Promise<void> {
    if (!this._connected || this.closed) throw new UserReadError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    const rooms = await this.reader.rooms();
    if (!this.closed) { this._rooms = rooms.map(r => ({ ...r })); this.changed(); }
  }
  async open(roomId: string): Promise<void> {
    if (!this._connected || this.closed) throw new UserReadError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    const generation = ++this.generation;
    this._active = undefined; this._messages = []; this._live = false; this._readError = undefined; this.changed();
    const room = this._rooms.find(r => r.id === roomId);
    if (!room || !this.canOpen(room)) throw new UserReadError('ROOM_NOT_AVAILABLE', '이 화면에서 열 수 없는 방입니다.');
    try {
      const result = await this.reader.history(room.id);
      if (this.closed || generation !== this.generation) return;
      this._active = room; this.merge(result.messages, [], true); this._live = true; this.changed();
    } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
  }
  async refresh(): Promise<void> {
    if (!this._connected || this.closed) throw new UserReadError('NOT_CONNECTED', '먼저 계정 연결을 확인하세요.');
    if (!this._active) { await this.refreshRooms(); return; }
    const roomId = this._active.id, generation = ++this.generation;
    try {
      const result = await this.reader.history(roomId);
      if (this.closed || generation !== this.generation) return;
      this.merge(result.messages, [], true); this._live = true; this._readError = undefined; this.changed();
    } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
  }
  async poll(): Promise<void> {
    if (!this._active || !this._live || this.closed) return;
    const roomId = this._active.id, generation = this.generation;
    if (this.pollRequest?.generation === generation) return this.pollRequest.promise;
    const visible = this._messages.map(m => m.messageId), after = visible.at(-1) ?? '0';
    const versions = Object.fromEntries(this._messages.filter(m => m.version).map(m => [m.messageId, m.version!]));
    const promise = (async () => {
      try {
        const result = await this.reader.updates(roomId, after, visible, versions);
        if (this.closed || generation !== this.generation) return;
        this.merge(result.messages, result.removedIds, result.reset);
      } catch (e) { if (generation === this.generation) this.failRead(e); throw e; }
    })();
    this.pollRequest = { generation, promise };
    try { await promise; } finally { if (this.pollRequest?.promise === promise) this.pollRequest = undefined; }
  }
  private failRead(error: unknown): void {
    this._live = false; this._messages = []; this._readError = error; this.changed();
  }
  private merge(incoming: UserMessage[], removed: string[], reset: boolean): void {
    if (!Array.isArray(incoming) || incoming.some(m => !validId(m.messageId) || !validId(m.authorId)) || !Array.isArray(removed)) {
      throw new UserReadError('INVALID_RESPONSE', '대화 응답 형식이 올바르지 않습니다.');
    }
    const map = new Map((reset ? [] : this._messages).map(m => [m.messageId, m]));
    for (const id of removed) map.delete(id);
    for (const m of incoming) map.set(m.messageId, { ...m });
    const next = [...map.values()].sort(ordered).slice(-USER_READ_LIMITS.visible);
    if (next.length !== this._messages.length || next.some((m, i) => !equal(m, this._messages[i]))) {
      this._messages = next; this.changed();
    }
  }
  async send(text: string): Promise<void> {
    const room = this._active;
    if (!room || !this.canOpen(room)) throw new UserReadError('ROOM_NOT_AVAILABLE', '먼저 방을 선택하세요.');
    if (this._pending) throw new UserReadError('SEND_PENDING', '앞선 전송 결과를 먼저 확인하세요. 새 요청으로 다시 보내지 않습니다.');
    const generation = this.generation;
    const identity = await this.writer.identity();
    if (this.closed || generation !== this.generation || this._active?.id !== room.id) throw new UserReadError('ROOM_NOT_AVAILABLE', '방이 변경되었습니다. 전송할 방을 다시 확인하세요.');
    if (this._pending) throw new UserReadError('SEND_PENDING', '앞선 전송 결과를 먼저 확인하세요.');
    if (!identity.connected) throw new UserReadError('NOT_CONNECTED', '전송 연결이 끊겼습니다.');
    if (identity.userId !== this._userId) throw new UserReadError('ACCOUNT_MISMATCH', '전송 계정이 달라졌습니다. 연결 설정을 확인하세요.');
    const request = { chatId: room.id, text, requestId: randomUUID(), uncertain: false };
    this._pending = request;
    let result: WriteResult;
    try { result = await this.writer.send(room.id, text, request.requestId); }
    catch { result = { ok: false, code: 'SEND_OUTCOME_UNKNOWN', message: '전송 결과가 불확실합니다. 카카오톡에서 확인하고 새 요청으로 다시 보내지 마세요.', uncertain: true }; }
    if (!result.ok) {
      if (result.uncertain || result.code === 'APPROVAL_REQUIRED') request.uncertain = result.uncertain;
      else this._pending = undefined;
      this.changed(); throw new UserReadError(result.code, result.message);
    }
    if (!validId(result.messageId)) { request.uncertain = true; throw new UserReadError('SEND_OUTCOME_UNKNOWN', '전송 응답을 확인할 수 없습니다. 새 요청으로 다시 보내지 마세요.'); }
    this._pending = undefined;
    if (!this.closed && this._active?.id === request.chatId && this._userId) {
      this.merge([{ messageId: result.messageId, authorId: this._userId, text, type: 1, sendAt: Date.now() / 1000 }], [], false);
    }
    this.changed();
  }
  close(): void { this.closed = true; this.generation++; this._active = undefined; this._messages = []; this._rooms = []; this._userId = undefined; this._connected = false; this._live = false; }
}
