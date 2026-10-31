// ----------------------------------------------------------------------------
// Live inbound feed for request/response adapters.
//
// Content reads use a bounded ring buffer; authorized resource subscribers get change signals.
// The buffer contains recent events
// (messages and read receipts) with a monotonic sequence: callers poll with
// `recent(sinceSeq)` or long-poll with `wait(sinceSeq, timeoutMs)`.
// ----------------------------------------------------------------------------

import type { IncomingMessage, ReadReceipt } from '@kakao-max/protocol';

export interface BufferedMessage extends IncomingMessage {
  /** Monotonic sequence for cursor-based polling. */
  seq: number;
  authorName?: string;
}

export const MESSAGE_BUFFER_MAX = 500;

export class MessageFeed {
  private readonly buffer: BufferedMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly max: number;
  private seq = 0;
  private readonly listeners = new Set<(chatId: string) => void>();

  onMessage(listener: (chatId: string) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  constructor(max = MESSAGE_BUFFER_MAX) {
    this.max = max;
  }

  /** The current head sequence — pass it as `sinceSeq` to only see future events. */
  get cursor(): number {
    return this.seq;
  }

  /** Append a message; returns it with its assigned sequence. */
  push(m: IncomingMessage & { authorName?: string }): BufferedMessage {
    const item: BufferedMessage = { ...m, seq: ++this.seq };
    this.append(item);
    for (const listener of [...this.listeners]) listener(String(item.chatId));
    return item;
  }

  /** Append a read receipt as a type -1 event carrying the watermark. */
  pushReadReceipt(r: ReadReceipt): BufferedMessage | undefined {
    if (!r.chatId || !r.watermark) return undefined;
    const item: BufferedMessage = {
      seq: ++this.seq,
      chatId: String(r.chatId),
      authorId: r.userId || '',
      type: -1,
      text: '',
      sendAt: Math.floor(Date.now() / 1000),
      raw: { isReadReceipt: true, watermark: String(r.watermark), userId: r.userId }
    };
    this.append(item);
    return item;
  }

  /** Events after `sinceSeq` (exclusive), optionally for one chat. */
  recent(sinceSeq = 0, chatId?: string): BufferedMessage[] {
    return this.buffer.filter((m) => m.seq > sinceSeq && (!chatId || m.chatId === chatId));
  }

  /** Resolve as soon as an event after `sinceSeq` exists, or with [] after timeoutMs. */
  async wait(sinceSeq: number, timeoutMs: number, chatId?: string): Promise<BufferedMessage[]> {
    const existing = this.recent(sinceSeq, chatId);
    if (existing.length) return existing;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const idx = this.waiters.indexOf(wake);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(this.recent(sinceSeq, chatId));
      };
      const wake = () => {
        if (this.recent(sinceSeq, chatId).length) finish();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.waiters.push(wake);
    });
  }

  private append(item: BufferedMessage): void {
    this.buffer.push(item);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
    for (const w of [...this.waiters]) w();
  }
}
