import { randomUUID } from 'node:crypto';
import type { KakaoDb } from './db.ts';
import { KakaoError } from './errors.ts';
import type { AgentMode } from './agent-mode.ts';

/**
 * How a deny- or manual-room read is approved. `confirmRead` is only honoured from inside a human-approved
 * operation request and only for manual rooms; plain agent read tools pass a `readGrant` created by a
 * human-approved `read_room` operation instead.
 */
export interface ReadApproval { confirmRead?: boolean; readGrant?: ReadGrantRef }
export interface ReadGrantRef { id: string; tool: ReadGrantTool }
/** MCP tools a one-time read grant can cover (read_messages covers history, live feeds and search). */
export const READ_GRANT_TOOLS = ['read_messages', 'download_attachment', 'preview_unread', 'get_chat_meta',
  'claim_message_events', 'ack_message_events',
  'export_chat_history', 'collect_shared_links', 'extract_schedule_and_todos', 'search_vault'] as const;
export type ReadGrantTool = string;
const grantTools = new Set<string>(READ_GRANT_TOOLS);
/** An optional module's read tool that a grant may name; its reads still go through this policy. */
export function registerReadGrantTool(tool: string): void {
  if (!/^[a-z][a-z_]{0,63}$/.test(tool)) throw new KakaoError('CONFIG_INVALID', 'Invalid read grant tool name');
  grantTools.add(tool);
}
export function isReadGrantTool(tool: unknown): tool is ReadGrantTool { return typeof tool === 'string' && grantTools.has(tool); }
export interface ReadGrant { grantId: string; chatId: string; tools: ReadGrantTool[]; maxMessages: number; usesLeft: number; createdAt: number; expiresAt: number; revoked: boolean }
interface ReadGrantRow extends Record<string, import('node:sqlite').SQLOutputValue> { grant_id: string; chat_id: string; tools: string; max_messages: number; uses_left: number; created_at: number; expires_at: number; revoked_at: number | null }
export interface RoomAccessRule {
  mode: 'deny' | 'manual' | 'scheduled' | 'immediate';
  /** An expired temporary rule falls back to deny, never to a broader rule. */
  expiresAt?: string;
  maxMessages?: number;
  /** Explicit, expiring approval for LOCAL text preview after a frozen log bound only. */
  unreadPreviewAfterLogId?: string;
  callsPerHour?: number;
  schedule?: {
    timeZone: string;
    /** Local HH:MM daily openings, with a bounded window. DST follows IANA rules. */
    times?: string[];
    /** Alternatively open every N minutes from local midnight. */
    everyMinutes?: number;
    windowMinutes: number;
  };
}

const MODES = new Set(['deny', 'manual', 'scheduled', 'immediate']);
/** Rooms a person approves read by read; scheduled and immediate rooms need no grant. */
const grantable = (r: RoomAccessRule) => r.mode === 'deny' || r.mode === 'manual';
const invalid = () => new KakaoError('INVALID_ARGUMENT', 'Invalid room access rule');
const integer = (x: unknown, min: number, max: number) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

export function parseRoomAccessRule(value: unknown): RoomAccessRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const r = value as Record<string, any>;
  if (Object.keys(r).some(k => !['mode', 'expiresAt', 'maxMessages', 'callsPerHour', 'schedule', 'unreadPreviewAfterLogId'].includes(k)) || !MODES.has(r.mode) ||
      (r.maxMessages !== undefined && !integer(r.maxMessages, 1, 100)) ||
      (r.callsPerHour !== undefined && !integer(r.callsPerHour, 1, 3600)) ||
      (r.expiresAt !== undefined && (typeof r.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.expiresAt) || !Number.isFinite(Date.parse(r.expiresAt))))) throw invalid();
  if (r.unreadPreviewAfterLogId !== undefined &&
      (r.mode !== 'manual' || !r.expiresAt || !integer(r.maxMessages, 1, 20) ||
       typeof r.unreadPreviewAfterLogId !== 'string' || !/^\d{1,19}$/.test(r.unreadPreviewAfterLogId) ||
       BigInt(r.unreadPreviewAfterLogId) > 9223372036854775807n)) throw invalid();
  if (r.mode === 'scheduled') {
    const s = r.schedule;
    if (!s || typeof s !== 'object' || Array.isArray(s) ||
        Object.keys(s).some(k => !['timeZone', 'times', 'everyMinutes', 'windowMinutes'].includes(k)) ||
        typeof s.timeZone !== 'string' || !integer(s.windowMinutes, 1, 60) ||
        (s.times === undefined) === (s.everyMinutes === undefined)) throw invalid();
    try { new Intl.DateTimeFormat('en', { timeZone: s.timeZone }).format(0); } catch { throw invalid(); }
    if (s.times !== undefined && (!Array.isArray(s.times) || s.times.length < 1 || s.times.length > 24 ||
        s.times.some((t: unknown) => typeof t !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(s.times).size !== s.times.length)) throw invalid();
    if (s.everyMinutes !== undefined && (!integer(s.everyMinutes, 1, 1440) || s.windowMinutes > s.everyMinutes)) throw invalid();
  } else if (r.schedule !== undefined) throw invalid();
  // Detach from caller-owned mutable objects.
  return JSON.parse(JSON.stringify(r)) as RoomAccessRule;
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_CALLS_PER_HOUR = 60;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys((value as Record<string, unknown>)[k])]));
}

/**
 * True only when `next` grants nothing `previous` (the effective rule) did not.
 * Anything else, including a mode change other than to deny, needs human approval.
 */
export function isRoomAccessTightening(previous: RoomAccessRule, next: RoomAccessRule): boolean {
  if (next.mode === 'deny') return true;
  if (previous.mode !== next.mode || !sameJson(previous.schedule ?? null, next.schedule ?? null) ||
      previous.unreadPreviewAfterLogId !== next.unreadPreviewAfterLogId) return false;
  const atMost = (n: number | undefined, p: number | undefined, fallback: number) => (n ?? fallback) <= (p ?? fallback);
  const expiry = previous.expiresAt === undefined ||
    next.expiresAt !== undefined && Date.parse(next.expiresAt) <= Date.parse(previous.expiresAt);
  return expiry && atMost(next.maxMessages, previous.maxMessages, DEFAULT_MAX_MESSAGES) &&
    atMost(next.callsPerHour, previous.callsPerHour, DEFAULT_CALLS_PER_HOUR);
}

/** Governs exposure, not transport receipt, local retention, read receipts or sends. */
export class RoomAccessPolicy {
  /**
   * `trust` reads rooms that have no stored rule, and so does every mode for the account's own memo chat
   * (`isMemoChat`: nobody else writes there). A stored rule, including an explicit deny, always wins.
   */
  constructor(privateDb: KakaoDb, now: () => number = Date.now, opts: { mode?: AgentMode; isMemoChat?: (chatId: string) => boolean } = {}) {
    this.db = privateDb;
    this.now = now;
    this.mode = opts.mode ?? 'ask';
    this.isMemoChat = opts.isMemoChat ?? (() => false);
  }
  private readonly db: KakaoDb;
  private readonly now: () => number;
  private readonly mode: AgentMode;
  private readonly isMemoChat: (chatId: string) => boolean;

  /** The rule a room has when nothing is stored for it. */
  defaultRule(chatId: string): RoomAccessRule {
    return this.mode === 'trust' || this.isMemoChat(chatId) ? { mode: 'immediate' } : { mode: 'deny' };
  }

  rule(chatId: string): RoomAccessRule {
    const raw = this.db.getMeta(`room-access:${chatId}`);
    if (!raw) return this.defaultRule(chatId);
    let rule: RoomAccessRule;
    try { rule = parseRoomAccessRule(JSON.parse(raw)); }
    catch { throw new KakaoError('CONFIG_INVALID', 'Stored room access rule is invalid; access refused'); }
    return rule.expiresAt && Date.parse(rule.expiresAt) <= this.now() ? { mode: 'deny' } : rule;
  }

  /** Trusted internal setter. MCP broadening reaches this only after the engine verifies human approval. */
  set(chatId: string, value: unknown): RoomAccessRule {
    if (!/^\d{1,19}$/.test(chatId) || BigInt(chatId) <= 0n) throw invalid();
    const rule = parseRoomAccessRule(value);
    if (rule.expiresAt && Date.parse(rule.expiresAt) <= this.now()) throw invalid();
    if (rule.unreadPreviewAfterLogId !== undefined && Date.parse(rule.expiresAt!) > this.now() + 30 * 60_000) {
      throw new KakaoError('INVALID_ARGUMENT', 'Unread preview approval must expire within 30 minutes');
    }
    this.db.transaction(() => {
      const previous = this.db.getMeta(`room-access:${chatId}`) ?? null;
      this.db.setMeta(`room-access:${chatId}`, JSON.stringify(rule));
      this.db.setMeta(`room-access-audit:${randomUUID()}`, JSON.stringify({ at: new Date(this.now()).toISOString(), chatId, previous, rule }));
    });
    // Rule changes never erase rate history or turn expiry into an implicit grant.
    return rule;
  }

  /** Rooms whose effective rule is not deny, for the permission list. Expired rules count as deny. */
  listRules(): Array<{ chatId: string; rule: RoomAccessRule }> {
    const rows = this.db.db.prepare("SELECT key FROM meta WHERE key LIKE 'room-access:%' ORDER BY key").all() as Array<{ key: string }>;
    return rows.map(r => r.key.slice('room-access:'.length)).map(chatId => ({ chatId, rule: this.rule(chatId) })).filter(r => r.rule.mode !== 'deny');
  }

  /** Agent-safe change: narrows the effective rule without approval, refuses anything broader. */
  tighten(chatId: string, value: unknown): RoomAccessRule {
    const next = parseRoomAccessRule(value);
    if (!isRoomAccessTightening(this.rule(chatId), next)) {
      throw new KakaoError('APPROVAL_REQUIRED', 'Broadening room access requires a human-approved grant_room_access operation');
    }
    return this.set(chatId, next);
  }

  /** Whether a rule is stored for this room, so the mode's default does not apply. */
  hasStoredRule(chatId: string): boolean { return this.db.getMeta(`room-access:${chatId}`) !== undefined; }

  /**
   * Agent-safe return to the default: drops the stored rule when the default grants nothing the effective rule
   * does not. A broader default (memo chat, trust) needs a human-approved reset_room_access instead.
   */
  restoreDefault(chatId: string): { rule: RoomAccessRule; changed: boolean } {
    if (!/^\d{1,19}$/.test(chatId) || BigInt(chatId) <= 0n) throw invalid();
    if (!this.hasStoredRule(chatId)) return { rule: this.defaultRule(chatId), changed: false };
    let current: RoomAccessRule;
    try { current = this.rule(chatId); } catch { current = { mode: 'deny' }; } // unreadable rules are refused, so treat as deny
    if (!isRoomAccessTightening(current, this.defaultRule(chatId))) {
      throw new KakaoError('APPROVAL_REQUIRED', 'The default rule is broader than this room\'s rule; returning to it requires a human-approved reset_room_access operation');
    }
    return { rule: this.reset(chatId), changed: true };
  }

  /** Trusted internal reset. MCP reaches this for a broader default only after the engine verifies human approval. */
  reset(chatId: string): RoomAccessRule {
    if (!/^\d{1,19}$/.test(chatId) || BigInt(chatId) <= 0n) throw invalid();
    this.db.transaction(() => {
      const key = `room-access:${chatId}`, previous = this.db.getMeta(key) ?? null;
      if (previous === null) return;
      this.db.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      this.db.setMeta(`room-access-audit:${randomUUID()}`, JSON.stringify({ at: new Date(this.now()).toISOString(), chatId, previous, rule: null, reason: 'reset' }));
    });
    return this.defaultRule(chatId);
  }

  /**
   * Create a one-shot read grant for a deny or manual room; only callable after the human approved `read_room`.
   * The room's rule is unchanged, so the next read asks again.
   */
  createReadGrant(grant: { grantId: string; chatId: string; tools: ReadGrantTool[]; maxMessages: number; uses: number; expiresAt: number }): ReadGrant {
    const r = this.rule(grant.chatId);
    if (!grantable(r)) throw new KakaoError('POLICY_DENIED', 'Read grants apply only to rooms in deny or manual mode');
    if (!integer(grant.maxMessages, 1, r.maxMessages ?? DEFAULT_MAX_MESSAGES) || !integer(grant.uses, 1, 20) || grant.expiresAt <= this.now() ||
        grant.expiresAt > this.now() + 60 * 60_000 || !grant.tools.length || grant.tools.some(t => !isReadGrantTool(t))) throw invalid();
    this.db.db.prepare('INSERT INTO read_grants (grant_id, chat_id, tools, max_messages, uses_left, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(grant.grantId, grant.chatId, JSON.stringify(grant.tools), grant.maxMessages, grant.uses, this.now(), grant.expiresAt);
    return this.readGrant(grant.grantId)!;
  }
  readGrant(grantId: string): ReadGrant | undefined {
    const row = this.db.db.prepare('SELECT * FROM read_grants WHERE grant_id = ?').get(grantId) as ReadGrantRow | undefined;
    return row && { grantId: row.grant_id, chatId: row.chat_id, tools: JSON.parse(row.tools), maxMessages: row.max_messages,
      usesLeft: row.uses_left, createdAt: row.created_at, expiresAt: row.expires_at, revoked: row.revoked_at !== null };
  }
  listReadGrants(): ReadGrant[] {
    return (this.db.db.prepare('SELECT grant_id FROM read_grants WHERE revoked_at IS NULL AND expires_at > ? AND uses_left > 0 ORDER BY created_at')
      .all(this.now()) as Array<{ grant_id: string }>).map(r => this.readGrant(r.grant_id)!);
  }
  /**
   * The account left the room: what was approved for that membership does not carry over to a rejoin.
   * Drops a stored rule when the mode's default is no broader, otherwise stores deny, and revokes the
   * room's read grants. A stored deny stays. Narrowing only, so no approval.
   */
  forgetRoom(chatId: string, reason: string): { rule: boolean; readGrants: number } {
    return this.db.transaction(() => {
      const key = `room-access:${chatId}`, previous = this.db.getMeta(key) ?? null;
      let stored: RoomAccessRule | undefined;
      try { stored = previous === null ? undefined : parseRoomAccessRule(JSON.parse(previous)); } catch { /* unreadable: store deny */ }
      const rule = previous !== null && stored?.mode !== 'deny';
      if (rule) {
        const drop = stored !== undefined && isRoomAccessTightening(stored, this.defaultRule(chatId));
        if (drop) this.db.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
        else this.db.setMeta(key, JSON.stringify({ mode: 'deny' }));
        this.db.setMeta(`room-access-audit:${randomUUID()}`, JSON.stringify({ at: new Date(this.now()).toISOString(), chatId, previous,
          rule: drop ? null : { mode: 'deny' }, reason }));
      }
      const readGrants = this.db.db.prepare('UPDATE read_grants SET revoked_at = ? WHERE chat_id = ? AND revoked_at IS NULL').run(this.now(), chatId).changes;
      return { rule, readGrants: Number(readGrants) };
    });
  }

  /** Narrowing: always allowed without approval. */
  revokeReadGrant(grantId: string): boolean {
    return this.db.db.prepare('UPDATE read_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(this.now(), grantId).changes === 1;
  }
  /** A grant authorizes this chat, tool and size; uses are consumed only by take(). */
  private grantFits(chatId: string, ref: ReadGrantRef | undefined, count: number, needUse: boolean): boolean {
    if (!ref || typeof ref.id !== 'string') return false;
    const g = this.readGrant(ref.id);
    return !!g && !g.revoked && g.chatId === chatId && g.expiresAt > this.now() && g.tools.includes(ref.tool) &&
      count <= g.maxMessages && (!needUse || g.usesLeft > 0);
  }

  check(chatId: string, approval: ReadApproval = {}, count = 1, needUse = false): void {
    const r = this.rule(chatId);
    const confirmed = r.mode === 'manual' && approval.confirmRead === true;
    if (grantable(r) && !confirmed && !this.grantFits(chatId, approval.readGrant, count, needUse)) {
      throw new KakaoError('POLICY_DENIED', r.mode === 'manual'
        ? 'This manual room needs a human-approved read_room grant (readGrantId) covering this chat, tool and size'
        : 'Room content access is denied by default or by its configured rule; read_messages asks the person when the client can show a dialog');
    }
    if (!integer(count, 1, r.maxMessages ?? DEFAULT_MAX_MESSAGES)) throw new KakaoError('INVALID_ARGUMENT', 'Read exceeds the room message limit');
    if (r.mode === 'scheduled' && !this.isOpen(r.schedule!)) {
      throw new KakaoError('POLICY_DENIED', 'Room content is outside its configured reading window');
    }
  }

  /** Durable per-room and global budget, reserved before any content/network work. */
  take(chatId: string, approval: ReadApproval = {}, count = 1): void {
    this.check(chatId, approval, count, true);
    // Only a deny or manual room consumes a grant use; broader rules never spend it.
    const rule = this.rule(chatId);
    const spend = grantable(rule) && !(rule.mode === 'manual' && approval.confirmRead === true) ? approval.readGrant?.id : undefined;
    const now = this.now();
    const key = `room-read-budget:${chatId}`;
    this.db.transaction(() => {
      const load = (k: string, window: number): number[] => {
        const raw = this.db.getMeta(k);
        let rows: unknown;
        try { rows = raw ? JSON.parse(raw) : []; }
        catch { throw new KakaoError('CONFIG_INVALID', 'Stored read budget is invalid; access refused'); }
        if (!Array.isArray(rows) || rows.some(t => typeof t !== 'number' || !Number.isFinite(t))) {
          throw new KakaoError('CONFIG_INVALID', 'Stored read budget is invalid; access refused');
        }
        // A backwards clock must not reset the budget.
        return (rows as number[]).filter(t => t > now - window);
      };
      const room = load(key, 3600_000), global = load('room-read-global-budget', 60_000);
      if (room.length >= (this.rule(chatId).callsPerHour ?? DEFAULT_CALLS_PER_HOUR) || global.length >= 60) {
        throw new KakaoError('RATE_LIMITED', 'Room content read budget exhausted; do not poll in a loop');
      }
      if (spend !== undefined && this.db.db.prepare('UPDATE read_grants SET uses_left = uses_left - 1 WHERE grant_id = ? AND uses_left > 0 AND revoked_at IS NULL AND expires_at > ?')
        .run(spend, now).changes !== 1) throw new KakaoError('POLICY_DENIED', 'Read grant is used up, revoked or expired');
      this.db.setMeta(key, JSON.stringify([...room, now]));
      this.db.setMeta('room-read-global-budget', JSON.stringify([...global, now]));
    });
  }

  private isOpen(s: NonNullable<RoomAccessRule['schedule']>): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: s.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(this.now());
    const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
    if (s.everyMinutes !== undefined) return minute % s.everyMinutes < s.windowMinutes;
    return s.times!.some(t => {
      const [h, m] = t.split(':').map(Number);
      return (minute - (h * 60 + m) + 1440) % 1440 < s.windowMinutes;
    });
  }
}
