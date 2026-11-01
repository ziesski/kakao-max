// A content-free durable send journal and transport-independent agent operation service.
// No protocol connection is created here. The adapter owns the existing account session.
import { WriteOperationEngine, type WriteDefinition } from './operation-engine.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { KakaoDb } from './db.ts';
import { KakaoError, toKakaoError } from './errors.ts';
import { isOwnerOnly, fsyncDir } from './private-fs.ts';
import type { SendPolicy, SendCategory, RateLimitConfig } from './policy.ts';

export interface AgentMessage {
  chatId: string;
  text: string;
  replyToLogId?: string;
  replyToUserId?: string;
  replyToText?: string;
  mentions?: Array<{ userId: string; at: number[]; len: number }>;
}
export interface AgentOperationAdapter<T extends { chatId: string }> {
  accountId(): string;
  connected(): boolean;
  /** Bounded locally known metadata only, not server history or message contents. */
  context(chatId: string): string;
  send(message: T, attempt?: SendAttempt): Promise<{ status: number; logId?: string }>;
  /** The room's newest known log ID, recorded before a send so its history can be searched from there. */
  roomCursor?(chatId: string): string | undefined;
  /** Look for our own message with this client message ID in the room's server history after `sinceLogId`. */
  findSent?(chatId: string, msgId: number, sinceLogId: string): Promise<{ found: true; logId: string } | { found: false; complete: boolean }>;
  /** Wait up to `timeoutMs` for the account session to (re)connect. */
  waitConnected?(timeoutMs: number): Promise<boolean>;
}
/** One send attempt: the client message ID the server echoes in the room's chat log. */
export interface SendAttempt { msgId: number }
/** A stable client message ID for a request: a retry with the same requestId carries the same msgId. */
export function clientMsgIdFor(requestId: string): number {
  return (createHash('sha256').update(`kakao-max:msgId:${requestId}`).digest().readUInt32BE(0) & 0x7fffffff) || 1;
}
interface AttemptRecord { chatId: string; msgId: number; since: string; at: number }
/** How long after an attempt an absent message counts as not delivered: a slow server may still be processing it. */
export const SETTLE_GRACE_MS = 30_000;
const SETTLE_WAIT_MS = 10_000;
export type AgentSendAdapter = AgentOperationAdapter<AgentMessage>;
/** Durable human approvals (MCP client dialog or passkey page) for exact prepared envelopes. */
export interface StoredApprovals {
  /** When an approver verified exactly this text, or undefined if none did (or it was removed). */
  approvalTime(requestId: string, signingText: string): number | undefined;
  configured(): boolean;
}
/** After a passkey approval the agent has this long to commit, even past the approval deadline. */
export const COMMIT_WINDOW_MS = 5 * 60_000;
/** Without operator configuration every action keeps the original five-minute approval window. */
export const DEFAULT_APPROVAL_WINDOW_MS = 5 * 60_000;
export type ApprovalWindow = (action: string) => number;
/** Room send permission granted by the person, bounded by the daily limit. */
export interface RoomSendApprovals {
  covers(action: string, message: Record<string, unknown>): string | undefined;
  consume(requestId: string, action: string, message: Record<string, unknown>): boolean;
}
export function approvalWindowMs(window: ApprovalWindow | undefined, action: string): number {
  const ms = window ? window(action) : DEFAULT_APPROVAL_WINDOW_MS;
  if (!Number.isSafeInteger(ms) || ms < 5 * 60_000 || ms > 30 * 60_000 || ms % 60_000) throw new KakaoError('CONFIG_INVALID', 'Approval windows must be whole minutes from 5 to 30');
  return ms;
}
/**
 * One deadline rule for every service. Rows expire for good after approval deadline + commit window.
 * A stored approval opens a commit window from the moment it was verified.
 */
export function requireApproval(o: {
  journal: AgentSendJournal; row: AgentOperationRow; now: number; envelope: string; required: boolean; missing: string;
  approvals?: StoredApprovals;
  /** Last resort before APPROVAL_REQUIRED: a human-approved room send permission. */
  permission?: () => boolean;
}): void {
  const expire = () => {
    o.journal.transition(o.row.request_id, o.row.state, 'expired');
    return new KakaoError('OPERATION_EXPIRED', 'The approval window or the commit window after approval elapsed; prepare a new reviewed operation');
  };
  if (!o.required) {
    if (o.row.expires_at <= o.now) throw expire();
    return;
  }
  const approvedAt = o.approvals?.approvalTime(o.row.request_id, o.envelope);
  if (approvedAt !== undefined) {
    if (approvedAt + COMMIT_WINDOW_MS <= o.now) throw expire();
    return;
  }
  if (o.row.expires_at <= o.now) throw expire();
  if (o.permission?.()) return;
  // The exact text lets a transport ask the human directly (MCP elicitation); the agent already has it from prepare.
  throw new KakaoError('APPROVAL_REQUIRED', o.missing, { details: { approval: { requestId: o.row.request_id, signingText: o.envelope, expiresAt: o.row.expires_at } } });
}
export interface AgentOperationDefinition<T extends { chatId: string }> {
  domain: string; action: string; parse(input: T): T; textLength(input: T): number; requireSignature?: boolean;
  /** A single WRITE whose failures can be told apart and whose outcome can be settled from room history. */
  settles?: boolean;
}
export type AgentOperationState = 'prepared' | 'approved' | 'sending' | 'sent_unverified' | 'send_unknown' | 'expired' | 'stale' | 'applied_unverified' | 'mutation_unknown' | 'applied' | 'rejected';
type State = AgentOperationState;
type Row = AgentOperationRow;
export interface AgentOperationRow extends Record<string, import('node:sqlite').SQLOutputValue> {
  request_id: string; payload_digest: string; room_digest: string; attempted_at: number | null; context_digest: string; policy_digest: string;
  created_at: number; expires_at: number; state: State; message_id: string | null; category: SendCategory;
}
export interface AgentSendResult { status: 0; logId: string; requestId: string; state: 'sent_unverified'; category: SendCategory; }
const POLICY_VERSION = 'agent-message-v1';
const MAX_ROWS = 10000; // Never evict an old request ID and silently enable replay.

export function canonicalAgentJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function requestId(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new KakaoError('INVALID_ARGUMENT', 'A stable UUID requestId is required');
}
/** Strict contract at the application boundary; preserve exact whitespace and Unicode. */
export function parseAgentMessage(input: AgentMessage): AgentMessage {
  if (!input || typeof input !== 'object' || !identity(input.chatId) || typeof input.text !== 'string' ||
      !input.text.trim() || Buffer.byteLength(input.text) > 4000 ||
      Object.keys(input).some(k => !['chatId','text','replyToLogId','replyToUserId','replyToText','mentions'].includes(k))) {
    throw new KakaoError('INVALID_ARGUMENT', 'An exact room and bounded message payload are required');
  }
  if ((input.replyToLogId !== undefined || input.replyToUserId !== undefined || input.replyToText !== undefined) &&
      (!identity(input.replyToLogId) || !identity(input.replyToUserId) ||
        input.replyToText !== undefined && (typeof input.replyToText !== 'string' || Buffer.byteLength(input.replyToText) > 4000))) {
    throw new KakaoError('INVALID_ARGUMENT', 'Reply source IDs and bounded quote text are required');
  }
  if (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.length > 50 || input.mentions.some(m =>
    !m || !identity(m.userId) || !Array.isArray(m.at) || !m.at.length || m.at.length > 50 ||
    !Number.isSafeInteger(m.len) || m.len < 1 || m.at.some(at => !Number.isSafeInteger(at) || at < 1 || at + m.len > input.text.length) ||
    Object.keys(m).some(k => !['userId','at','len'].includes(k))))) {
    throw new KakaoError('INVALID_ARGUMENT', 'Invalid mention contract');
  }
  if (input.replyToLogId && input.mentions?.length) throw new KakaoError('INVALID_ARGUMENT', 'Reply and mentions cannot be silently combined');
  return JSON.parse(canonicalAgentJson(input)) as AgentMessage;
}

function readPrivateFile(file: string, max: number): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !isOwnerOnly(stat) || stat.size > max) throw new Error('Unsafe file');
    return fs.readFileSync(fd);
  } catch (cause) { throw new KakaoError('CONFIG_INVALID', 'Agent operation key is unavailable or unsafe', { cause }); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function journalIO<T>(fn: () => T): T {
  try { return fn(); }
  catch (cause) {
    if (cause instanceof KakaoError) throw cause;
    throw new KakaoError('INTERNAL', 'Agent operation storage failed', { cause });
  }
}

export class AgentSendJournal {
  private readonly key: Buffer;
  readonly db: KakaoDb;
  private constructor(db: KakaoDb, key: Buffer) {
    if (key.length !== 32) throw new KakaoError('CONFIG_INVALID', 'Invalid agent journal key');
    db.db.exec('PRAGMA synchronous = FULL');
    this.db = db; this.key = Buffer.from(key);
  }
  static open(directory: string): AgentSendJournal {
    const db = KakaoDb.open({ dir: directory, importLegacy: false });
    const file = path.join(directory, 'agent-send.key');
    try {
      db.db.exec('PRAGMA synchronous = FULL');
      const marker = db.getMeta('agent-send-key-id');
      let created = false;
      if (!fs.existsSync(file)) {
        if (marker || (db.db.prepare('SELECT COUNT(*) AS n FROM agent_send_operations').get() as { n: number }).n > 0) throw new KakaoError('CONFIG_INVALID', 'Existing journal has lost its key; do not regenerate or resend');
        const key = randomBytes(32); let fd: number | undefined;
        try {
          fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, key); fs.fsyncSync(fd);
          fsyncDir(directory);
        } finally { if (fd !== undefined) fs.closeSync(fd); key.fill(0); }
        created = true;
      }
      const bytes = readPrivateFile(file, 32);
      try {
        const keyId = createHash('sha256').update(bytes).digest('hex');
        if (created) db.transaction(() => db.setMeta('agent-send-key-id', keyId));
        else if (marker !== keyId) throw new KakaoError('CONFIG_INVALID', 'Agent journal source/key identity changed; manual recovery is required');
        return new AgentSendJournal(db, bytes);
      } finally { bytes.fill(0); }
    } catch (cause) { db.close(); if (cause instanceof KakaoError) throw cause; throw new KakaoError('CONFIG_INVALID', 'Agent journal initialization failed', { cause }); }
  }
  digest(value: unknown): string { return createHmac('sha256', this.key).update(canonicalAgentJson(value)).digest('hex'); }
  get(id: string): Row | undefined { return journalIO(() => this.db.db.prepare('SELECT * FROM agent_send_operations WHERE request_id = ?').get(id) as Row | undefined); }
  prepare(row: Row): Row {
    return journalIO(() => this.db.transaction(() => {
      const previous = this.get(row.request_id);
      if (previous) return previous;
      const count = this.db.db.prepare('SELECT COUNT(*) AS n FROM agent_send_operations').get() as { n: number };
      if (count.n >= MAX_ROWS) throw new KakaoError('POLICY_DENIED', 'Agent journal capacity reached; operator maintenance required');
      this.db.db.prepare(`INSERT INTO agent_send_operations
        (request_id,payload_digest,room_digest,context_digest,policy_digest,created_at,expires_at,state,category)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(row.request_id,row.payload_digest,row.room_digest,row.context_digest,row.policy_digest,row.created_at,row.expires_at,row.state,row.category);
      return row;
    }));
  }
  claim(id: string, rate: RateLimitConfig, now: number): boolean {
    return journalIO(() => this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.state !== 'approved') return false;
      const counts = this.db.db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN room_digest = ? THEN 1 ELSE 0 END),0) AS room
        FROM agent_send_operations WHERE attempted_at > ?`).get(row.room_digest, now - rate.windowMs) as { total: number; room: number };
      if (rate.global > 0 && counts.total >= rate.global || rate.perChat > 0 && counts.room >= rate.perChat) {
        throw new KakaoError('RATE_LIMITED', 'Durable agent send attempt limit reached; do not retry in a loop');
      }
      return this.db.db.prepare("UPDATE agent_send_operations SET state = 'sending', attempted_at = ? WHERE request_id = ? AND state = 'approved'")
        .run(now, id).changes === 1;
    }));
  }
  transition(id: string, from: State, to: State, messageId: string | null = null): boolean {
    return journalIO(() => this.db.db.prepare('UPDATE agent_send_operations SET state = ?, message_id = ? WHERE request_id = ? AND state = ?')
      .run(to, messageId, id, from).changes === 1);
  }
  /** Content-free record of a send attempt (room, client message ID, history position, time). */
  recordAttempt(id: string, attempt: AttemptRecord): void { journalIO(() => this.db.setMeta(`send-attempt:${id}`, JSON.stringify(attempt))); }
  attempt(id: string): AttemptRecord | undefined {
    const raw = journalIO(() => this.db.getMeta(`send-attempt:${id}`));
    if (!raw) return undefined;
    const a = JSON.parse(raw) as AttemptRecord;
    return identity(a.chatId) && Number.isInteger(a.msgId) && typeof a.since === 'string' && Number.isSafeInteger(a.at) ? a : undefined;
  }
  /** Request IDs still in `state`, most recent first. */
  inState(state: State, limit = 20): string[] {
    return journalIO(() => (this.db.db.prepare('SELECT request_id FROM agent_send_operations WHERE state = ? ORDER BY attempted_at DESC LIMIT ?')
      .all(state, limit) as Array<{ request_id: string }>).map(r => r.request_id));
  }
  close(): void { this.key.fill(0); this.db.close(); }
}

/**
 * The error to report when a text send certainly did not reach the account: no connection before writing,
 * the server refused it, or local validation failed. A connection that closed after the WRITE was written stays uncertain.
 */
function sendNotApplied(error: unknown): KakaoError | undefined {
  if (error instanceof KakaoError && error.details?.stage === 'before_send') return error;
  const e = toKakaoError(error);
  const notSent = (e.code === 'NOT_CONNECTED' && e.details?.locoCode !== 'CLOSED') ||
    e.code === 'LOCO_STATUS' || e.code === 'AUTH_EXPIRED' || e.code === 'INVALID_ARGUMENT';
  if (!notSent) return undefined;
  return new KakaoError(e.code, `The message was not sent: ${e.message}`, { retryable: e.code !== 'INVALID_ARGUMENT', ...(e.details ? { details: e.details } : {}), cause: error });
}

export class AgentOperationService<T extends { chatId: string }> {
  constructor(privateDeps: AgentOperationService<T>['deps']) {
    if (!/^[a-z][a-z0-9:-]{0,63}$/.test(privateDeps.principal)) throw new KakaoError('CONFIG_INVALID', 'A trusted application principal is required');
    this.deps = privateDeps;
  }
  private readonly deps: { principal: string; journal: AgentSendJournal; adapter: AgentOperationAdapter<T>; definition: AgentOperationDefinition<T>; policy: SendPolicy; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow; recipients?: RoomSendApprovals; now?: () => number; modeApproves?: (action: string) => boolean; notifications?: boolean };
  private payloadDigest(message: T): string {
    const account = this.deps.adapter.accountId();
    if (!identity(account)) throw new KakaoError('NOT_CONNECTED', 'Verified account identity required');
    return this.deps.journal.digest({ domain: this.deps.definition.domain, principal: this.deps.principal, account, action: this.deps.definition.action, message });
  }
  private policyDigest(): string {
    const p = this.deps.policy.describe();
    return this.deps.journal.digest({ version: this.deps.definition.domain, ...(this.deps.definition.requireSignature ? { requireSignature: true } : {}), notify: this.deps.notifications ? p.notifyChatId : null,
      ceiling: p.ceiling,
      paused: p.paused, rate: { windowMs: p.rateLimit.windowMs, perChat: p.rateLimit.perChat, global: p.rateLimit.global } });
  }
  private category(message: T): SendCategory {
    const p = this.deps.policy;
    const decision = p.decide(message.chatId);
    if (!decision.allowed) {
      p.auditRefusal(message.chatId, decision, this.deps.definition.textLength(message));
      throw new KakaoError(decision.reason.startsWith('rate limited') ? 'RATE_LIMITED' : 'POLICY_DENIED', `Agent message policy refused this operation: ${decision.reason}`);
    }
    // Only the daemon's own notifier may skip approval for the notice destination; agents need a room permission there too.
    return decision.category === 'notification' && this.deps.notifications ? 'notification' : 'message-as-you';
  }
  private envelope(row: Row, message: T): string {
    return canonicalAgentJson({ domain: this.deps.definition.domain, action: this.deps.definition.action, principal: this.deps.principal,
      accountId: this.deps.adapter.accountId(), requestId: row.request_id, message,
      contextDigest: row.context_digest, policyDigest: row.policy_digest,
      createdAt: row.created_at, expiresAt: row.expires_at, commitWindowMs: COMMIT_WINDOW_MS });
  }
  private definition(id: string, message: T): WriteDefinition<void, { status: number; logId?: string }, AgentSendResult> {
    const { journal, adapter, policy } = this.deps;
    return {
      action: this.deps.definition.action, payloadDigest: this.payloadDigest(message),
      roomDigest: journal.digest({ account: adapter.accountId(), room: message.chatId }), policyDigest: () => this.policyDigest(),
      inspect: () => {},
      context: () => adapter.context(message.chatId), category: () => {
        if (!adapter.connected()) throw new KakaoError('NOT_CONNECTED', 'Account is not connected');
        return this.category(message);
      },
      envelope: row => this.envelope(row, message),
      requiresApproval: row => this.deps.definition.requireSignature === true || row.category !== 'notification',
      permissionId: () => this.deps.recipients?.covers(this.deps.definition.action, message as Record<string, unknown>),
      consumePermission: () => this.deps.recipients?.consume(id, this.deps.definition.action, message as Record<string, unknown>) ?? false,
      validate: () => {
        if (!adapter.connected()) throw new KakaoError('NOT_CONNECTED', 'Account is not connected');
        this.category(message);
      }, authorize: () => {
        if (!policy.authorize(message.chatId, this.deps.definition.textLength(message)).allowed)
          throw new KakaoError('POLICY_DENIED', 'Policy changed before send claim');
      },
      rateLimit: () => policy.describe().rateLimit,
      execute: () => {
        if (!this.deps.definition.settles) return adapter.send(message);
        const attempt = { msgId: clientMsgIdFor(id) };
        try {
          journal.recordAttempt(id, { chatId: message.chatId, msgId: attempt.msgId, since: adapter.roomCursor?.(message.chatId) ?? '0', at: this.now() });
        } catch (cause) {
          throw new KakaoError('INTERNAL', 'Send attempt could not be recorded; nothing was sent', { details: { stage: 'before_send' }, cause });
        }
        return adapter.send(message, attempt);
      },
      ...(this.deps.definition.settles ? { notApplied: sendNotApplied, settle: () => this.settleAttempt(id) } : {}),
      messageId: out => out.logId ?? null, valid: out => out.status === 0 && identity(out.logId),
      done: 'sent_unverified', uncertain: 'send_unknown', unknown: () => this.unknown(),
      result: row => ({ status: 0, logId: row.message_id!, requestId: row.request_id, state: 'sent_unverified', category: row.category })
    };
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  /** Look the attempt up in the room's history: delivered, not delivered (after a grace period), or still unknown. */
  private async settleAttempt(id: string): Promise<{ applied: true; messageId: string | null } | { applied: false } | undefined> {
    const { journal, adapter } = this.deps, attempt = journal.attempt(id);
    if (!attempt || !adapter.findSent) return undefined;
    if (!(adapter.waitConnected ? await adapter.waitConnected(SETTLE_WAIT_MS) : adapter.connected())) return undefined;
    const found = await adapter.findSent(attempt.chatId, attempt.msgId, attempt.since);
    if (found.found) return { applied: true, messageId: found.logId };
    return found.complete && this.now() - attempt.at >= SETTLE_GRACE_MS ? { applied: false } : undefined;
  }
  /**
   * Settle uncertain sends from room history, e.g. after reconnecting. A settled send becomes `sent_unverified`
   * or returns to `approved` (send again with the same requestId); nothing is sent here. Returns how many remain uncertain.
   */
  async settlePending(): Promise<number> {
    if (!this.deps.definition.settles) return 0;
    let remaining = 0;
    const engine = new WriteOperationEngine(this.deps);
    for (const id of this.deps.journal.inState('send_unknown')) {
      const settled = await engine.settle(id, { uncertain: 'send_unknown', done: 'sent_unverified', settle: () => this.settleAttempt(id) });
      if (!settled) remaining++;
    }
    return remaining;
  }
  prepare(id: string, raw: T) {
    requestId(id); const message = this.deps.definition.parse(raw);
    const prepared = new WriteOperationEngine(this.deps).prepare(id, this.definition(id, message));
    return { ...prepared, signingText: prepared.signingText ?? this.envelope(this.deps.journal.get(id)!, message) };
  }
  async send(id: string, raw: T): Promise<AgentSendResult> {
    requestId(id); const message = this.deps.definition.parse(raw);
    return new WriteOperationEngine(this.deps).commit(id, this.definition(id, message));
  }
  private unknown(): KakaoError { return new KakaoError('SEND_OUTCOME_UNKNOWN', 'A send may have occurred; inspect Kakao manually. Never automatically resend or replace its request ID.', { retryable: false }); }
}

/** Preserve the original text envelope and HMAC domain for existing prepared operations. */
export class AgentSendService extends AgentOperationService<AgentMessage> {
  constructor(deps: { principal: string; journal: AgentSendJournal; adapter: AgentSendAdapter; policy: SendPolicy; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow; recipients?: RoomSendApprovals; now?: () => number; modeApproves?: (action: string) => boolean; notifications?: boolean }) {
    super({ ...deps, definition: { domain: POLICY_VERSION, action: 'send_message', parse: parseAgentMessage, textLength: m => m.text.length, settles: true } });
  }
}
