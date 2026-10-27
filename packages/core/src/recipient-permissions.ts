// Room send permissions: like a phone app permission, the person allows sending to a room once and later
// sends there need no per-message approval. Limited to messages and photos/files to that exact room,
// within a daily cap per room; pause, room ceiling and rate limits still apply on every send.
import { KakaoError } from './errors.ts';
import type { AgentSendJournal, RoomSendApprovals } from './agent-send.ts';

/** Publications an allowed recipient covers. Forwarding, edits, deletes and account changes are not. */
export const RECIPIENT_ACTIONS = ['send_message', 'send_media', 'send_photo_bundle'] as const;
export interface RecipientPermission { grantId: string; chatId: string; grantedAt: number; approver: string; dailyLimit: number | null; usedToday: number }
interface Row extends Record<string, import('node:sqlite').SQLOutputValue> { chat_id: string; granted_at: number; approver: string; revoked_at: number | null }

export class RecipientPermissions implements RoomSendApprovals {
  private readonly journal: AgentSendJournal;
  private readonly dailyLimit: number | null;
  private readonly timeZone: string;
  private readonly now: () => number;
  private readonly allRooms: boolean;
  private readonly isMemoChat: (chatId: string) => boolean;
  /**
   * `allRooms` (trust mode): every room counts as allowed without a stored grant; the room ceiling, pause and
   * rate limits still apply in SendPolicy. `isMemoChat`: the account's own memo chat is allowed in every mode,
   * since nothing sent there reaches anyone else; the daily limit still counts. `dailyLimit: null` means no daily cap.
   */
  constructor(journal: AgentSendJournal, opts: { dailyLimit: number | null; timeZone: string; now?: () => number; allRooms?: boolean; isMemoChat?: (chatId: string) => boolean }) {
    if (opts.dailyLimit !== null && (!Number.isSafeInteger(opts.dailyLimit) || opts.dailyLimit < 1 || opts.dailyLimit > 500)) throw new KakaoError('CONFIG_INVALID', 'Recipient daily limit must be 1 to 500');
    this.journal = journal; this.dailyLimit = opts.dailyLimit; this.timeZone = opts.timeZone; this.now = opts.now ?? Date.now;
    this.allRooms = opts.allRooms === true;
    this.isMemoChat = opts.isMemoChat ?? (() => false);
  }
  private db() { return this.journal.db.db; }
  private day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }
  private usedToday(chatId: string): number {
    return (this.db().prepare('SELECT COUNT(*) AS n FROM recipient_permission_uses WHERE chat_id = ? AND local_day = ?').get(chatId, this.day()) as { n: number }).n;
  }
  private active(chatId: string): Row | undefined {
    return this.db().prepare('SELECT * FROM recipient_permissions WHERE chat_id = ? AND revoked_at IS NULL').get(chatId) as Row | undefined;
  }
  private view(r: Row): RecipientPermission {
    return { grantId: `recipient:${r.chat_id}`, chatId: r.chat_id, grantedAt: r.granted_at, approver: r.approver, dailyLimit: this.dailyLimit, usedToday: this.usedToday(r.chat_id) };
  }
  /** Only after a human approval (client dialog, passkey page or a signed allow_recipient operation). */
  grant(chatId: string, approver: string): RecipientPermission {
    if (!/^[1-9]\d{0,18}$/.test(chatId) || !/^[a-z][a-z0-9:._-]{0,80}$/.test(approver)) throw new KakaoError('INVALID_ARGUMENT', 'Exact room ID and approver required');
    this.db().prepare('INSERT INTO recipient_permissions (chat_id, granted_at, approver) VALUES (?,?,?) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET granted_at = excluded.granted_at, approver = excluded.approver, revoked_at = NULL').run(chatId, this.now(), approver);
    return this.view(this.active(chatId)!);
  }
  get(chatId: string): RecipientPermission | undefined { const r = this.active(chatId); return r && this.view(r); }
  list(): RecipientPermission[] {
    return (this.db().prepare('SELECT * FROM recipient_permissions WHERE revoked_at IS NULL ORDER BY granted_at').all() as Row[]).map(r => this.view(r));
  }
  /** Narrowing: immediate, no approval. */
  revoke(chatId: string): boolean {
    return this.db().prepare('UPDATE recipient_permissions SET revoked_at = ? WHERE chat_id = ? AND revoked_at IS NULL').run(this.now(), chatId).changes === 1;
  }
  /** A stored grant, the memo chat, or in trust mode any exact room id. */
  private allowed(chatId: string): string | undefined {
    if (this.active(chatId)) return `recipient:${chatId}`;
    if (/^[1-9]\d{0,18}$/.test(chatId) && this.isMemoChat(chatId)) return `memo:${chatId}`;
    return this.allRooms && /^[1-9]\d{0,18}$/.test(chatId) ? `trust:${chatId}` : undefined;
  }
  covers(action: string, message: Record<string, unknown>): string | undefined {
    const chatId = message.chatId;
    if (!(RECIPIENT_ACTIONS as readonly string[]).includes(action) || typeof chatId !== 'string') return undefined;
    const id = this.allowed(chatId);
    return id && (this.dailyLimit === null || this.usedToday(chatId) < this.dailyLimit) ? id : undefined;
  }
  consume(requestId: string, action: string, message: Record<string, unknown>): boolean {
    return this.journal.db.transaction(() => {
      const chatId = message.chatId;
      // A recorded reservation is accounting, not an approval that survives revocation.
      if (!(RECIPIENT_ACTIONS as readonly string[]).includes(action) || typeof chatId !== 'string' || !this.allowed(chatId)) return false;
      const previous = this.db().prepare('SELECT chat_id, local_day FROM recipient_permission_uses WHERE request_id = ?').get(requestId) as
        { chat_id: string; local_day: string } | undefined;
      if (previous) return previous.chat_id === chatId && previous.local_day === this.day();
      if (!this.covers(action, message)) return false;
      this.db().prepare('INSERT INTO recipient_permission_uses (request_id, chat_id, local_day, used_at) VALUES (?,?,?,?)')
        .run(requestId, chatId, this.day(), this.now());
      return true;
    }, 'immediate');
  }
}
