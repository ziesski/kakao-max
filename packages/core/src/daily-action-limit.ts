// Daily cap on one account action (add_friend), counted per local day and kept in SQLite so a restart
// does not reset it. Applies in every agent mode: trust skips the person's approval, not this cap.
// Rows hold only the action name and day, never the target user.
import { KakaoError } from './errors.ts';
import type { KakaoDb } from './db.ts';

export class DailyActionLimit {
  private readonly db: KakaoDb;
  private readonly action: string;
  readonly limit: number;
  private readonly timeZone: string;
  private readonly now: () => number;

  constructor(db: KakaoDb, opts: { action: string; limit: number; timeZone: string; now?: () => number }) {
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new KakaoError('CONFIG_INVALID', `Daily limit for ${opts.action} must be a positive whole number`);
    this.db = db; this.action = opts.action; this.limit = opts.limit; this.timeZone = opts.timeZone; this.now = opts.now ?? Date.now;
  }
  private day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }
  usedToday(): number {
    return (this.db.db.prepare('SELECT COUNT(*) AS n FROM account_action_uses WHERE action = ? AND local_day = ?').get(this.action, this.day()) as { n: number }).n;
  }
  private refuse(used: number): KakaoError {
    // Not retryable: the same call fails until the local day changes.
    return new KakaoError('RATE_LIMITED', `Daily ${this.action} limit reached (${used}/${this.limit}, KAKAO_ADD_FRIEND_DAILY_LIMIT); try again tomorrow. Do not retry in a loop.`,
      { retryable: false, details: { action: this.action, limit: this.limit, usedToday: used } });
  }
  /** Fail before asking a person to approve something the cap would refuse anyway. */
  check(): void {
    const used = this.usedToday();
    if (used >= this.limit) throw this.refuse(used);
  }
  /** Take one slot after approval and before the effect. A slot is not returned if the effect then fails. */
  reserve(): void {
    this.db.transaction(() => {
      const used = this.usedToday();
      if (used >= this.limit) throw this.refuse(used);
      this.db.db.prepare('INSERT INTO account_action_uses (action, local_day, used_at) VALUES (?,?,?)').run(this.action, this.day(), this.now());
    }, 'immediate');
  }
}
