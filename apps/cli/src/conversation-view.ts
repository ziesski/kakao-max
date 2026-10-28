import type { ConversationMessage, ConversationRoom } from '@kakao-max/client';
import { ConversationError } from '@kakao-max/client';
import { terminalText as shellText, type DisplayOptions } from './terminal-text.ts';

/** Display aliases are local to the view; they never change account rooms or agent permissions. */
export class ConversationView {
  private readonly options: DisplayOptions;
  private readonly aliases = new Map<string, string>();
  private readonly authors = new Map<string, string>();
  private publicId?: string;
  constructor(options: DisplayOptions) {
    if (options.demo && !options.showRoom?.trim()) throw new ConversationError('CONFIG_INVALID', '촬영 모드에는 --show-room으로 공개할 방을 지정하세요.');
    this.options = options;
  }
  update(rooms: readonly ConversationRoom[]): void {
    for (const r of rooms) if (!this.aliases.has(r.id)) this.aliases.set(r.id, `대화방 ${String(this.aliases.size + 1).padStart(3, '0')}`);
    if (this.options.demo) {
      const key = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
      const matches = rooms.filter(r => key(r.title ?? '') === key(this.options.showRoom!));
      if (matches.length !== 1 || this.publicId !== undefined && this.publicId !== matches[0].id) {
        throw new ConversationError('ROOM_NOT_AVAILABLE', '공개할 방이 없거나 중복·변경됐습니다. 방 이름을 확인하세요.');
      }
      this.publicId = matches[0].id;
    }
  }
  canOpen(room: ConversationRoom): boolean { return !this.options.demo || room.id === this.publicId; }
  label(room: ConversationRoom): string { return this.options.demo && !this.canOpen(room) ? this.aliases.get(room.id)! : shellText(room.title || this.aliases.get(room.id)); }
  message(m: ConversationMessage, userId?: string): string {
    const mine = m.authorId === userId;
    if (!mine && !this.authors.has(m.authorId)) this.authors.set(m.authorId, `참여자 ${this.authors.size + 1}`);
    const author = mine ? '나' : this.options.demo ? this.authors.get(m.authorId)! : shellText(m.authorName || this.authors.get(m.authorId));
    const time = Number.isFinite(m.sendAt) ? new Date(m.sendAt! * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
    let text = m.text || '(첨부 메시지)';
    if (m.type === 0) text = '(대화방 알림)';
    else if (m.type !== undefined && m.type !== 1) text = '(첨부 메시지)';
    else { try { const payload = JSON.parse(text); if (payload && typeof payload === 'object' && 'feedType' in payload) text = '(대화방 알림)'; } catch { /* plain text */ } }
    return `${time}  ${author}  ${shellText(text)}`;
  }
}
