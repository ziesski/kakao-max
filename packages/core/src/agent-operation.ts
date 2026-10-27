// Control action definitions and adapter over the shared write engine.
// The content-free journal also records writes; narrowing changes need no approval.
// Text, publications, mutations and controls use the same lifecycle engine with separate payload domains.
import { WriteOperationEngine, type WriteDefinition } from './operation-engine.ts';
import { AgentSendJournal, canonicalAgentJson, COMMIT_WINDOW_MS, type AgentOperationRow, type StoredApprovals, type ApprovalWindow } from './agent-send.ts';
import { KakaoError } from './errors.ts';
import type { RateLimitConfig } from './policy.ts';
import { parseRoomAccessRule, isReadGrantTool, type RoomAccessRule } from './room-access.ts';

export interface AgentOperationDefinition<R = any, C = any> {
  action: string;
  /** local: applied to this installation's own state, so the outcome is known; remote: a provider side effect. */
  effect: 'local' | 'remote';
  parseRequest(input: unknown): R;
  /** Closed, bounded review context: no raw protocol data or credentials. */
  parseContext(request: R, input: unknown): C;
  /** Durable rate/claim subject, e.g. a room or a policy switch. */
  scope(request: R): string;
}
export interface AgentOperationInspection<C = unknown> {
  context: C;
  /** Synchronous final local check immediately before the durable fence. */
  validate(): void;
  /** `result` is a bounded, content-free acknowledgement returned once; it is not journaled. */
  execute(): Promise<{ status: number; result?: Record<string, unknown> }>;
}
export interface AgentOperationEngineAdapter {
  accountId(): string;
  inspect(action: string, request: unknown): Promise<AgentOperationInspection>;
}
export interface AgentOperationResult { status: 0; requestId: string; action: string; state: 'applied' | 'applied_unverified'; result?: Record<string, unknown>; }
export interface AgentOperationPrepared {
  requestId: string; action: string; state: string; expiresAt: number;
  approvalRequired: true; approvalConfigured: boolean; signingText?: string;
}

export function agentOperationDomain(action: string): string { return `agent-op-v1:${action}`; }
function identity(x: unknown): x is string { return typeof x === 'string' && /^[1-9]\d{0,18}$/.test(x) && BigInt(x) <= 9223372036854775807n; }
function uuid(x: unknown): x is string { return typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x); }
function invalid(message = 'An exact bounded operation request is required'): never { throw new KakaoError('INVALID_ARGUMENT', message); }
function closed(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}
const optionalText = (x: unknown, max: number) => x === null || typeof x === 'string' && Buffer.byteLength(x) <= max;
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

// ── control actions: policy broadening that an agent must never perform on its own ──

export interface GrantRoomAccessRequest { chatId: string; rule: RoomAccessRule; }
export interface GrantRoomAccessContext {
  kind: 'room-access'; chatId: string; previous: RoomAccessRule;
  room: { title: string | null; type: string | null; memberCount: number | null };
}
export interface ResumeSendingContext {
  kind: 'pause'; paused: true; notifyChatId: string | null; ceiling: string[];
  rateLimit: { windowMs: number; perChat: number; global: number };
}

const grantRoomAccess: AgentOperationDefinition<GrantRoomAccessRequest, GrantRoomAccessContext> = {
  action: 'grant_room_access', effect: 'local',
  parseRequest(input) {
    if (!closed(input, ['chatId', 'rule']) || !identity(input.chatId)) invalid();
    return JSON.parse(canonicalAgentJson({ chatId: input.chatId, rule: parseRoomAccessRule(input.rule) }));
  },
  parseContext(request, input) {
    if (!closed(input, ['kind', 'chatId', 'previous', 'room']) || input.kind !== 'room-access' || input.chatId !== request.chatId ||
        !closed(input.room, ['title', 'type', 'memberCount']) || !optionalText(input.room.title, 1024) ||
        !optionalText(input.room.type, 32) || !(input.room.memberCount === null || count(input.room.memberCount))) invalid('Invalid operation context');
    return JSON.parse(canonicalAgentJson({ ...input, previous: parseRoomAccessRule(input.previous) }));
  },
  scope: request => `room-access:${request.chatId}`
};

export interface ResetRoomAccessRequest { chatId: string; }
export interface ResetRoomAccessContext {
  kind: 'room-access-reset'; chatId: string; previous: RoomAccessRule; next: RoomAccessRule;
  room: { title: string | null; type: string | null; memberCount: number | null };
}

// Returning to a broader default (memo chat, trust) widens access, so the person reviews both rules.
const resetRoomAccess: AgentOperationDefinition<ResetRoomAccessRequest, ResetRoomAccessContext> = {
  action: 'reset_room_access', effect: 'local',
  parseRequest(input) {
    if (!closed(input, ['chatId']) || !identity(input.chatId)) invalid();
    return { chatId: input.chatId };
  },
  parseContext(request, input) {
    if (!closed(input, ['kind', 'chatId', 'previous', 'next', 'room']) || input.kind !== 'room-access-reset' || input.chatId !== request.chatId ||
        !closed(input.room, ['title', 'type', 'memberCount']) || !optionalText(input.room.title, 1024) ||
        !optionalText(input.room.type, 32) || !(input.room.memberCount === null || count(input.room.memberCount))) invalid('Invalid operation context');
    return JSON.parse(canonicalAgentJson({ ...input, previous: parseRoomAccessRule(input.previous), next: parseRoomAccessRule(input.next) }));
  },
  scope: request => `room-access:${request.chatId}`
};

const resumeSending: AgentOperationDefinition<Record<string, never>, ResumeSendingContext> = {
  action: 'resume_sending', effect: 'local',
  parseRequest(input) {
    if (!closed(input, [])) invalid();
    return {};
  },
  parseContext(_request, input) {
    if (!closed(input, ['kind', 'paused', 'notifyChatId', 'ceiling', 'rateLimit']) || input.kind !== 'pause' || input.paused !== true ||
        !(input.notifyChatId === null || identity(input.notifyChatId)) ||
        !Array.isArray(input.ceiling) || input.ceiling.length > 1000 ||
        input.ceiling.some((x: unknown) => !identity(x)) ||
        canonicalAgentJson(input.ceiling) !== canonicalAgentJson([...new Set(input.ceiling)].sort()) ||
        !closed(input.rateLimit, ['windowMs', 'perChat', 'global']) ||
        !['windowMs', 'perChat', 'global'].every(k => count(input.rateLimit[k]))) invalid('Invalid operation context');
    return JSON.parse(canonicalAgentJson(input));
  },
  scope: () => 'policy:pause'
};

// ── account-visible and local-import actions formerly gated only by an agent-supplied confirm ──

export interface RoomSummary { title: string | null; type: string | null; memberCount: number | null; }
export interface FriendSummary { known: boolean; nickname: string | null; type: number | null; }
const LOG = /^(0|[1-9]\d{0,18})$/;
const logId = (x: unknown): x is string => typeof x === 'string' && LOG.test(x) && BigInt(x) <= 9223372036854775807n;
function room(x: unknown): x is RoomSummary {
  return closed(x, ['title', 'type', 'memberCount']) && optionalText(x.title, 1024) && optionalText(x.type, 32) &&
    (x.memberCount === null || count(x.memberCount));
}
function friend(x: unknown): x is FriendSummary {
  return closed(x, ['known', 'nickname', 'type']) && typeof x.known === 'boolean' && optionalText(x.nickname, 1024) &&
    (x.type === null || Number.isSafeInteger(x.type));
}
/** Exact keys, explicit defaults, canonical order: the digest never depends on omitted optionals. */
function exact(input: unknown, required: string[], optional: Record<string, (x: unknown) => boolean>, defaults: Record<string, unknown> = {}) {
  if (!closed(input, [...required, ...Object.keys(optional)]) || required.some(k => input[k] === undefined) ||
      Object.entries(input).some(([k, v]) => required.includes(k) ? false : v !== undefined && !optional[k](v))) invalid();
  const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  return JSON.parse(canonicalAgentJson({ ...defaults, ...defined })) as Record<string, any>;
}
const bool = (x: unknown) => typeof x === 'boolean';
function context<C>(input: unknown, kind: string, check: (c: Record<string, any>) => boolean): C {
  if (!closed(input, ['kind', 'chatId', 'userId', 'jobId', 'room', 'friend', 'job']) || input.kind !== kind || !check(input)) invalid('Invalid operation context');
  return JSON.parse(canonicalAgentJson(input)) as C;
}
const roomContext = (request: { chatId: string }, input: unknown) =>
  context<{ kind: 'room'; chatId: string; room: RoomSummary }>(input, 'room', c => Object.keys(c).length === 3 && c.chatId === request.chatId && room(c.room));
const userContext = (request: { userId: string }, input: unknown) =>
  context<{ kind: 'user'; userId: string; friend: FriendSummary }>(input, 'user', c => Object.keys(c).length === 3 && c.userId === request.userId && friend(c.friend));
function roomAction(action: string, effect: 'local' | 'remote', parse: (input: unknown) => Record<string, any>): AgentOperationDefinition {
  return { action, effect, parseRequest: input => { const r = parse(input); if (!identity(r.chatId)) invalid(); return r; }, parseContext: roomContext, scope: r => r.chatId };
}
function userAction(action: string, parse: (input: unknown) => Record<string, any>): AgentOperationDefinition {
  return { action, effect: 'remote', parseRequest: input => { const r = parse(input); if (!identity(r.userId)) invalid(); return r; }, parseContext: userContext, scope: r => `user:${r.userId}` };
}
const ACCOUNT_DEFINITIONS: AgentOperationDefinition[] = [
  roomAction('leave_chat', 'remote', input => exact(input, ['chatId'], { silence: bool, block: bool }, { silence: false, block: false })),
  roomAction('set_chat_meta', 'remote', input => {
    const r = exact(input, ['chatId', 'type', 'content'], {});
    if (!Number.isSafeInteger(r.type) || r.type < 1 || r.type > 255 || typeof r.content !== 'string' || Buffer.byteLength(r.content) > 16384) invalid();
    return r;
  }),
  roomAction('mark_read', 'remote', input => { const r = exact(input, ['chatId', 'watermark'], {}); if (!identity(r.watermark)) invalid(); return r; }),
  userAction('create_direct_chat', input => exact(input, ['userId'], {})),
  userAction('block_user', input => exact(input, ['userId'], { blockType: x => x === 1 || x === 2 }, { blockType: 1 })),
  userAction('unblock_user', input => exact(input, ['userId'], {})),
  userAction('add_friend', input => exact(input, ['userId'], {})),
  // Room send permissions: allow later messages/photos to this exact room without per-message approval.
  roomAction('allow_recipient', 'local', input => exact(input, ['chatId'], {})),
];

// ── scoped read grants: reviewed once, then consumed by bounded reads ──

const GRANT_DEFINITIONS: AgentOperationDefinition[] = [
  { action: 'read_room', effect: 'local',
    parseRequest: input => {
      const r = exact(input, ['chatId', 'tools'], { maxMessages: x => Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 100,
        uses: x => Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 20, ttlMinutes: x => Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 60 },
        { maxMessages: 20, uses: 1, ttlMinutes: 10 });
      if (!identity(r.chatId) || !Array.isArray(r.tools) || !r.tools.length || r.tools.some((t: unknown) => !isReadGrantTool(t)) ||
          new Set(r.tools).size !== r.tools.length) invalid();
      return { ...r, tools: [...r.tools].sort() };
    },
    // The reviewer sees the current deny or manual rule; a rule change before commit makes the grant stale.
    parseContext: (request, input) => {
      if (!closed(input, ['kind', 'chatId', 'rule', 'room']) || input.kind !== 'room-read' || input.chatId !== request.chatId || !room(input.room)) invalid('Invalid operation context');
      const rule = parseRoomAccessRule(input.rule);
      if (rule.mode !== 'manual' && rule.mode !== 'deny') invalid('Read grants apply only to rooms in deny or manual mode');
      return JSON.parse(canonicalAgentJson({ ...input, rule }));
    },
    scope: request => `read-grant:${request.chatId}` }
];

/**
 * Building blocks for approved operations defined outside core (optional modules), so their
 * requests and review contexts are parsed with the same exact-key, canonical rules.
 */
export const OPERATION_PARTS = { exact, context, roomAction, closed, invalid, identity, uuid, logId, count, bool } as const;

export const AGENT_CONTROL_DEFINITIONS: readonly AgentOperationDefinition[] = [grantRoomAccess, resetRoomAccess, resumeSending, ...ACCOUNT_DEFINITIONS, ...GRANT_DEFINITIONS];
export const AGENT_CONTROL_ACTIONS = AGENT_CONTROL_DEFINITIONS.map(d => d.action);
export function agentOperationDefinition(action: unknown, definitions: readonly AgentOperationDefinition[] = AGENT_CONTROL_DEFINITIONS): AgentOperationDefinition {
  const found = definitions.find(d => d.action === action);
  if (!found) invalid('Unsupported approved operation action');
  return found;
}
/** Canonical approval text shared by the engine and human approval channels. */
export function agentOperationEnvelope(fields: {
  action: string; principal: string; accountId: string; requestId: string; request: unknown; context: unknown;
  contextDigest: string; policyDigest: string; createdAt: number; expiresAt: number; commitWindowMs: number;
}): string {
  return canonicalAgentJson({ domain: agentOperationDomain(fields.action), ...fields });
}

export class AgentOperationEngine {
  private readonly deps: {
    principal: string; journal: AgentSendJournal; adapter: AgentOperationEngineAdapter;
    definitions: readonly AgentOperationDefinition[]; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow;
    /** Required only for remote effects; local control changes consume no send budget. */
    rateLimit?: () => RateLimitConfig; now?: () => number;
    /** The agent mode approves these actions without asking (trust); see agent-mode.ts. */
    modeApproves?: (action: string) => boolean;
  };
  constructor(deps: AgentOperationEngine['deps']) {
    if (!/^[a-z][a-z0-9:-]{0,63}$/.test(deps.principal) ||
        new Set(deps.definitions.map(d => d.action)).size !== deps.definitions.length ||
        deps.definitions.some(d => !/^[a-z][a-z_]{0,63}$/.test(d.action) || d.effect === 'remote' && !deps.rateLimit)) {
      throw new KakaoError('CONFIG_INVALID', 'A trusted principal and distinct operation definitions are required');
    }
    this.deps = deps;
  }
  private account(): string {
    const account = this.deps.adapter.accountId();
    if (!identity(account)) throw new KakaoError('NOT_CONNECTED', 'Verified account identity required');
    return account;
  }
  private digest(definition: AgentOperationDefinition, request: unknown): string {
    return this.deps.journal.digest({ domain: agentOperationDomain(definition.action), principal: this.deps.principal, account: this.account(), request });
  }
  private policyDigest(definition: AgentOperationDefinition): string {
    return this.deps.journal.digest({ domain: agentOperationDomain(definition.action), requireSignature: true });
  }
  private envelope(definition: AgentOperationDefinition, request: unknown, context: unknown, row: AgentOperationRow): string {
    return agentOperationEnvelope({ action: definition.action, principal: this.deps.principal, accountId: this.account(), requestId: row.request_id,
      request, context, contextDigest: row.context_digest, policyDigest: row.policy_digest,
      createdAt: row.created_at, expiresAt: row.expires_at, commitWindowMs: COMMIT_WINDOW_MS });
  }
  private async inspect(definition: AgentOperationDefinition, request: unknown) {
    const inspection = await this.deps.adapter.inspect(definition.action, request);
    return { ...inspection, context: definition.parseContext(request, inspection.context) };
  }
  private definition(definition: AgentOperationDefinition, request: unknown): WriteDefinition<AgentOperationInspection, { status: number; result?: Record<string, unknown> }, AgentOperationResult> {
    return {
      action: definition.action, payloadDigest: this.digest(definition, request),
      roomDigest: this.deps.journal.digest({ account: this.account(), room: definition.scope(request) }),
      policyDigest: () => this.policyDigest(definition),
      inspect: () => { throw new KakaoError('INTERNAL', 'Control inspection requires the asynchronous engine path'); },
      context: i => i.context, category: () => 'message-as-you', envelope: (row, i) => this.envelope(definition, request, i.context, row),
      requiresApproval: () => true, validate: i => i.validate(), authorize: () => {},
      ...(definition.effect === 'remote' ? { rateLimit: this.deps.rateLimit } : {}), execute: i => i.execute(),
      messageId: () => null, valid: out => out.status === 0,
      done: definition.effect === 'remote' ? 'applied_unverified' : 'applied', uncertain: 'mutation_unknown', unknown: () => this.unknown(),
      result: (row, out) => ({ status: 0, requestId: row.request_id, action: definition.action, state: row.state as 'applied' | 'applied_unverified',
        ...(out?.result ? { result: out.result } : {}) })
    };
  }
  async prepare(action: string, id: string, raw: unknown) {
    const d = agentOperationDefinition(action, this.deps.definitions), request = d.parseRequest(raw);
    return { ...await new WriteOperationEngine(this.deps).prepareAsync(id, this.definition(d, request), () => this.inspect(d, request)), action };
  }
  async commit(action: string, id: string, raw: unknown): Promise<AgentOperationResult> {
    const d = agentOperationDefinition(action, this.deps.definitions), request = d.parseRequest(raw);
    return new WriteOperationEngine(this.deps).commit(id, this.definition(d, request), () => this.inspect(d, request));
  }

  /** Content-free lifecycle lookup. */
  status(id: string): { requestId: string; state: string; createdAt: number; expiresAt: number } {
    if (!uuid(id)) invalid('A stable UUID requestId is required');
    const row = this.deps.journal.get(id);
    if (!row) throw new KakaoError('NOT_FOUND', 'No operation with this request ID');
    return { requestId: id, state: row.state === 'sending' ? 'mutation_unknown' : row.state, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  private unknown(): KakaoError {
    return new KakaoError('MUTATION_OUTCOME_UNKNOWN', 'The operation may have been applied; inspect the current state manually. Never automatically repeat it or replace its request ID.', { retryable: false });
  }
}
