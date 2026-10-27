// Reviewed non-publication operations. Shares journal identity, claims and durable rate limits.
import { WriteOperationEngine, type WriteDefinition } from './operation-engine.ts';
import { parseEmoticonAttachment } from '@kakao-max/protocol';
import { AgentSendJournal, canonicalAgentJson, COMMIT_WINDOW_MS, type StoredApprovals, type ApprovalWindow } from './agent-send.ts';
import { KakaoError } from './errors.ts';
import type { SendPolicy, SendCategory } from './policy.ts';

export const AGENT_MUTATION_ACTIONS = ['send_emoticon','edit_message','delete_message','update_my_profile'] as const;
export type AgentMutationAction = typeof AGENT_MUTATION_ACTIONS[number];
export interface AgentMutationRequest {
  chatId?: string; logId?: string; text?: string; fromChatId?: string; fromLogId?: string; confirmRead?: boolean;
  profileId?: string; statusMessage?: string;
}
export interface AgentMutationContext { kind: 'message' | 'profile'; target: Record<string, any>; room?: Record<string, any>; sourceRoom?: Record<string, any>; }
export interface AgentMutationInspection {
  context: AgentMutationContext;
  /** Synchronous final local check, without consuming another read budget. */
  validate(): void;
  execute(): Promise<{ status: number; logId?: string }>;
}
export interface AgentMutationAdapter {
  accountId(): string; connected(): boolean;
  inspect(action: AgentMutationAction, request: AgentMutationRequest): Promise<AgentMutationInspection>;
}
export interface AgentMutationResult { status: 0; requestId: string; state: 'applied_unverified'; category: SendCategory; logId?: string; }
function identity(x: unknown): x is string { return typeof x === 'string' && /^[1-9]\d{0,18}$/.test(x) && BigInt(x) <= 9223372036854775807n; }
function uuid(x: unknown): x is string { return typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x); }
function invalid(): never { throw new KakaoError('INVALID_ARGUMENT', 'An exact bounded mutation request and explicit target are required'); }
function object(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}
export function agentMutationDomain(action: AgentMutationAction): string { return `agent-mutation-v1:${action}`; }
export function parseAgentMutationRequest(action: AgentMutationAction, input: AgentMutationRequest): AgentMutationRequest {
  const keys: Record<AgentMutationAction, string[]> = { send_emoticon: ['chatId','fromChatId','fromLogId','confirmRead'],
    edit_message: ['chatId','logId','text','confirmRead'], delete_message: ['chatId','logId','confirmRead'], update_my_profile: ['profileId','statusMessage'] };
  if (!AGENT_MUTATION_ACTIONS.includes(action) || !object(input, keys[action])) invalid();
  if (action === 'update_my_profile') {
    if (typeof input.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.profileId) ||
        typeof input.statusMessage !== 'string' || Buffer.byteLength(input.statusMessage) > 90) invalid();
  } else {
    if (!identity(input.chatId) || input.confirmRead !== undefined && typeof input.confirmRead !== 'boolean') invalid();
    if (action === 'send_emoticon') { if (!identity(input.fromChatId) || !identity(input.fromLogId)) invalid(); }
    else if (!identity(input.logId) || action === 'edit_message' && (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 4000)) invalid();
  }
  return JSON.parse(canonicalAgentJson(input)) as AgentMutationRequest;
}
/** Closed, bounded review context: no arbitrary raw protocol data or credentials. */
export function parseAgentMutationContext(action: AgentMutationAction, request: AgentMutationRequest, input: AgentMutationContext): AgentMutationContext {
  if (!object(input, ['kind','target','room','sourceRoom']) || Buffer.byteLength(canonicalAgentJson(input)) > 32768) invalid();
  if (action === 'update_my_profile') {
    if (input.kind !== 'profile' || input.room !== undefined || input.sourceRoom !== undefined || !object(input.target, ['profileId','nickname','statusMessage']) ||
      input.target.profileId !== request.profileId || ![input.target.nickname,input.target.statusMessage].every(x => x === null || typeof x === 'string')) invalid();
  } else {
    const t = input.target;
    if (input.kind !== 'message' || !object(t, ['chatId','messageId','authorId','type','text','attachment','revision']) ||
        t.chatId !== (action === 'send_emoticon' ? request.fromChatId : request.chatId) || t.messageId !== (action === 'send_emoticon' ? request.fromLogId : request.logId) ||
        !identity(t.authorId) || typeof t.text !== 'string' || Buffer.byteLength(t.text) > 4000 ||
        !(t.type === null || Number.isSafeInteger(t.type)) || !(t.revision === null || typeof t.revision === 'string' && /^(0|[1-9]\d{0,18})$/.test(t.revision)) || !(t.attachment === null || typeof t.attachment === 'string' && Buffer.byteLength(t.attachment) <= 16384)) invalid();
    if (action === 'send_emoticon' && (![6,12,20,22,25].includes(t.type) || !t.attachment || !parseEmoticonAttachment(t.attachment))) invalid();
    const room = (r: unknown) => object(r, ['maxLogId','memberCount']) && typeof r.maxLogId === 'string' && /^\d{1,19}$/.test(r.maxLogId) &&
      (r.memberCount === null || Number.isSafeInteger(r.memberCount) && r.memberCount >= 0);
    if (!room(input.room) || (action === 'send_emoticon' ? !room(input.sourceRoom) : input.sourceRoom !== undefined)) invalid();
  }
  return JSON.parse(canonicalAgentJson(input)) as AgentMutationContext;
}

export class AgentMutationService {
  /** `isMemoChat`: editing or deleting your own message in your memo chat needs no approval; it reaches nobody else. */
  private readonly deps: { principal: string; journal: AgentSendJournal; policy: SendPolicy; adapter: AgentMutationAdapter; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow; now?: () => number; modeApproves?: (action: string) => boolean; isMemoChat?: (chatId: string) => boolean };
  constructor(deps: AgentMutationService['deps']) {
    if (!/^[a-z][a-z0-9:-]{0,63}$/.test(deps.principal)) throw new KakaoError('CONFIG_INVALID', 'A trusted application principal is required');
    this.deps = deps;
  }
  private policyDigest(action: AgentMutationAction): string {
    const p = this.deps.policy.describe();
    return this.deps.journal.digest({ domain: agentMutationDomain(action), requireSignature: true, notify: p.notifyChatId,
      ceiling: p.ceiling,
      paused: p.paused, rate: { windowMs:p.rateLimit.windowMs,perChat:p.rateLimit.perChat,global:p.rateLimit.global } });
  }
  private digest(action: AgentMutationAction, request: AgentMutationRequest): string {
    if (!identity(this.deps.adapter.accountId())) throw new KakaoError('NOT_CONNECTED', 'Verified account identity required');
    return this.deps.journal.digest({ domain:agentMutationDomain(action),principal:this.deps.principal,account:this.deps.adapter.accountId(),request });
  }
  private decision(action: AgentMutationAction, request: AgentMutationRequest, consume = false) {
    const p = this.deps.policy, profile = action === 'update_my_profile';
    const key = `update_profile:${request.profileId}`;
    const d = profile ? consume ? p.authorizeAction(key, 'update_my_profile') : p.decideAction(key, 'update_my_profile')
      : consume ? p.authorize(request.chatId!,request.text?.length ?? 0) : p.decide(request.chatId!);
    if (!d.allowed) {
      if (!consume) p.auditRefusal(profile ? key : request.chatId!, d, request.text?.length ?? 0);
      throw new KakaoError(d.reason.startsWith('rate limited') ? 'RATE_LIMITED' : 'POLICY_DENIED', `Mutation policy refused the operation: ${d.reason}`);
    }
    return d;
  }
  private envelope(action: AgentMutationAction, request: AgentMutationRequest, context: AgentMutationContext, row: NonNullable<ReturnType<AgentSendJournal['get']>>): string {
    return canonicalAgentJson({domain:agentMutationDomain(action),action,principal:this.deps.principal,accountId:this.deps.adapter.accountId(),
      requestId:row.request_id,message:request,context,contextDigest:row.context_digest,policyDigest:row.policy_digest,createdAt:row.created_at,expiresAt:row.expires_at,commitWindowMs:COMMIT_WINDOW_MS});
  }
  private async inspect(action: AgentMutationAction, request: AgentMutationRequest) {
    if (!this.deps.adapter.connected()) throw new KakaoError('NOT_CONNECTED', 'Account is not connected');
    this.decision(action,request);
    const inspection = await this.deps.adapter.inspect(action,request), context = parseAgentMutationContext(action,request,inspection.context);
    if ((action === 'edit_message' || action === 'delete_message') && context.target.authorId !== this.deps.adapter.accountId()) throw new KakaoError('POLICY_DENIED', 'Only a locally stored message authored by this account may be changed');
    if (!this.deps.adapter.connected()) throw new KakaoError('NOT_CONNECTED','Account disconnected during inspection');
    if (action === 'edit_message' && context.target.type !== 1) throw new KakaoError('INVALID_ARGUMENT','Agent edits currently support stored plain text only; no type conversion fallback');
    inspection.validate();
    return {...inspection,context};
  }
  private definition(action: AgentMutationAction, request: AgentMutationRequest): WriteDefinition<AgentMutationInspection, { status: number; logId?: string }, AgentMutationResult> {
    return {
      action, payloadDigest: this.digest(action, request),
      roomDigest: this.deps.journal.digest({ account: this.deps.adapter.accountId(), room: action === 'update_my_profile' ? `profile:${request.profileId}` : request.chatId }),
      policyDigest: () => this.policyDigest(action),
      inspect: () => { throw new KakaoError('INTERNAL', 'Mutation inspection requires the asynchronous engine path'); },
      context: i => i.context, category: () => this.decision(action, request).category,
      envelope: (row, i) => this.envelope(action, request, i.context, row),
      requiresApproval: () => !((action === 'edit_message' || action === 'delete_message') && this.deps.isMemoChat?.(request.chatId!) === true),
      validate: i => i.validate(), authorize: () => { this.decision(action, request, true); },
      rateLimit: () => this.deps.policy.describe().rateLimit, execute: i => i.execute(),
      messageId: out => out.logId ?? null,
      valid: out => out.status === 0 && (action !== 'send_emoticon' || identity(out.logId)) && (out.logId === undefined || identity(out.logId)),
      done: 'applied_unverified', uncertain: 'mutation_unknown', unknown: () => this.unknown(),
      result: row => ({ status: 0, requestId: row.request_id, state: 'applied_unverified', category: row.category, ...(row.message_id ? { logId: row.message_id } : {}) })
    };
  }
  async prepare(action: AgentMutationAction, id: string, raw: AgentMutationRequest) {
    const request = parseAgentMutationRequest(action, raw);
    return new WriteOperationEngine(this.deps).prepareAsync(id, this.definition(action, request), () => this.inspect(action, request));
  }
  async commit(action: AgentMutationAction, id: string, raw: AgentMutationRequest): Promise<AgentMutationResult> {
    const request = parseAgentMutationRequest(action, raw);
    return new WriteOperationEngine(this.deps).commit(id, this.definition(action, request), () => this.inspect(action, request));
  }
  private unknown() { return new KakaoError('MUTATION_OUTCOME_UNKNOWN','An action may have occurred; inspect Kakao manually. Never automatically repeat it or replace its request ID.',{retryable:false}); }
}
