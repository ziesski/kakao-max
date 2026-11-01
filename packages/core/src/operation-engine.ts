// Shared lifecycle for every account write: review, approval, durable fence, effect, outcome.
// Definitions own parsing, policy and result shapes. No network session is created here.
import { KakaoError } from './errors.ts';
import { COMMIT_WINDOW_MS, approvalWindowMs, requireApproval, type AgentSendJournal, type AgentOperationRow, type AgentOperationState, type ApprovalWindow, type StoredApprovals } from './agent-send.ts';
import type { RateLimitConfig, SendCategory } from './policy.ts';

export interface WriteDefinition<I, O, R> {
  action: string;
  payloadDigest: string;
  roomDigest: string;
  policyDigest(): string;
  inspect(): I;
  context(inspection: I): unknown;
  category(inspection: I): SendCategory;
  envelope(row: AgentOperationRow, inspection: I): string;
  requiresApproval(row: AgentOperationRow): boolean;
  permissionId?(): string | undefined;
  consumePermission?(): boolean;
  validate(inspection: I): void;
  authorize(inspection: I): void;
  rateLimit?: () => RateLimitConfig;
  execute(inspection: I): Promise<O>;
  messageId(output: O): string | null;
  valid(output: O): boolean;
  done: 'sent_unverified' | 'applied_unverified' | 'applied';
  uncertain: 'send_unknown' | 'mutation_unknown';
  unknown(): KakaoError;
  /**
   * The effect certainly did not happen (nothing was written, or the server refused it): the error to report.
   * The operation returns to `approved`, so the same requestId can be committed again.
   */
  notApplied?(error: unknown): KakaoError | undefined;
  /**
   * Settle an uncertain attempt from the account's own history: applied (with its message ID), not applied,
   * or undefined while it cannot be told yet.
   */
  settle?(row: AgentOperationRow): Promise<{ applied: true; messageId: string | null } | { applied: false } | undefined>;
  result(row: AgentOperationRow, output?: O): R;
}
export interface WritePrepared {
  requestId: string; state: AgentOperationState; expiresAt: number; approvalRequired: boolean;
  approvalConfigured: boolean; signingText?: string; roomPermissionId?: string;
}

export class WriteOperationEngine {
  private readonly journal: AgentSendJournal;
  private readonly approvals?: StoredApprovals;
  private readonly approvalWindow?: ApprovalWindow;
  private readonly now: () => number;
  private readonly modeApproves?: (action: string) => boolean;
  /** `modeApproves`: the operator's agent mode approves this action without asking (trust); see agent-mode.ts. */
  constructor(deps: { journal: AgentSendJournal; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow; now?: () => number; modeApproves?: (action: string) => boolean }) {
    this.journal = deps.journal; this.approvals = deps.approvals;
    this.approvalWindow = deps.approvalWindow; this.now = deps.now ?? Date.now;
    this.modeApproves = deps.modeApproves;
  }
  private required<I, O, R>(row: AgentOperationRow, d: WriteDefinition<I, O, R>): boolean {
    return d.requiresApproval(row) && !this.modeApproves?.(d.action);
  }
  private row<I, O, R>(id: string, d: WriteDefinition<I, O, R>) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new KakaoError('INVALID_ARGUMENT', 'A stable UUID requestId is required');
    const row = this.journal.get(id);
    if (row && row.payload_digest !== d.payloadDigest)
      throw new KakaoError('IDEMPOTENCY_CONFLICT', 'Request ID belongs to another account, principal, action or payload');
    return row;
  }
  private prepared<I, O, R>(row: AgentOperationRow, d: WriteDefinition<I, O, R>): WritePrepared {
    const required = this.required(row, d), permissionId = required ? d.permissionId?.() : undefined;
    return { requestId: row.request_id, state: row.state === 'sending' ? d.uncertain : row.state,
      expiresAt: row.expires_at, approvalRequired: required && !permissionId,
      approvalConfigured: !!this.approvals?.configured(), ...(permissionId ? { roomPermissionId: permissionId } : {}) };
  }
  private terminal<I, O, R>(id: string, d: WriteDefinition<I, O, R>) {
    const row = this.row(id, d);
    return row && !['prepared', 'approved'].includes(row.state) ? this.prepared(row, d) : undefined;
  }
  private fresh<I, O, R>(row: AgentOperationRow, d: WriteDefinition<I, O, R>, inspection: I) {
    if (row.expires_at + COMMIT_WINDOW_MS <= this.now()) {
      this.journal.transition(row.request_id, row.state, 'expired');
      throw new KakaoError('OPERATION_EXPIRED', 'Operation approval expired; prepare a new reviewed operation');
    }
    if (row.context_digest !== this.journal.digest(d.context(inspection)) || row.policy_digest !== d.policyDigest()) {
      this.journal.transition(row.request_id, row.state, 'stale');
      throw new KakaoError('OPERATION_STALE', 'Operation target, room context or policy changed');
    }
  }
  private finishPrepare<I, O, R>(id: string, d: WriteDefinition<I, O, R>, inspection: I): WritePrepared {
    const now = this.now(), row = this.journal.prepare({ request_id: id, payload_digest: d.payloadDigest,
      room_digest: d.roomDigest, attempted_at: null, context_digest: this.journal.digest(d.context(inspection)),
      policy_digest: d.policyDigest(), created_at: now, expires_at: now + approvalWindowMs(this.approvalWindow, d.action),
      state: 'prepared', message_id: null, category: d.category(inspection) });
    this.row(id, d);
    if (!['prepared', 'approved'].includes(row.state)) return this.prepared(row, d);
    this.fresh(row, d, inspection);
    return { ...this.prepared(row, d), signingText: d.envelope(row, inspection) };
  }
  prepare<I, O, R>(id: string, d: WriteDefinition<I, O, R>): WritePrepared {
    return this.terminal(id, d) ?? this.finishPrepare(id, d, d.inspect());
  }
  async prepareAsync<I, O, R>(id: string, d: WriteDefinition<I, O, R>, inspect: () => Promise<I>): Promise<WritePrepared> {
    const terminal = this.terminal(id, d);
    if (terminal) return terminal;
    return this.finishPrepare(id, d, await inspect());
  }
  /**
   * Try to settle an uncertain attempt. Returns the row once it is done or back to `approved` (not applied),
   * or undefined while it stays uncertain. Only an attempt that has already returned is settled, never one in flight.
   */
  async settle(id: string, d: Pick<WriteDefinition<unknown, unknown, unknown>, 'uncertain' | 'done' | 'settle'>): Promise<AgentOperationRow | undefined> {
    const row = this.journal.get(id);
    if (!row || row.state !== d.uncertain || !d.settle) return undefined;
    let outcome: Awaited<ReturnType<NonNullable<WriteDefinition<unknown, unknown, unknown>['settle']>>>;
    try { outcome = await d.settle(row); } catch { return undefined; }
    if (!outcome) return undefined;
    const to = outcome.applied ? d.done : 'approved';
    if (!this.journal.transition(id, d.uncertain, to, outcome.applied ? outcome.messageId : null)) return undefined;
    return this.journal.get(id);
  }
  async commit<I, O, R>(id: string, d: WriteDefinition<I, O, R>, inspect: () => I | Promise<I> = d.inspect): Promise<R> {
    let row = this.row(id, d);
    if (!row) throw new KakaoError('APPROVAL_REQUIRED', 'Prepare this immutable operation first');
    if (row.state === d.uncertain) row = await this.settle(id, d) ?? row;
    if (row.state === d.done) return d.result(row);
    if (['sending', 'send_unknown', 'mutation_unknown'].includes(row.state)) throw d.unknown();
    if (row.state === 'expired') throw new KakaoError('OPERATION_EXPIRED', 'Operation approval expired');
    if (row.state === 'stale') throw new KakaoError('OPERATION_STALE', 'Operation approval is stale');
    if (row.state === 'rejected') throw new KakaoError('POLICY_DENIED', 'The operator rejected this operation');
    const pendingInspection = inspect();
    const inspection = pendingInspection instanceof Promise ? await pendingInspection : pendingInspection;
    this.fresh(row, d, inspection);
    requireApproval({ journal: this.journal, row, now: this.now(), envelope: d.envelope(row, inspection),
      required: this.required(row, d), approvals: this.approvals, permission: d.consumePermission,
      missing: 'Human approval is required (MCP client dialog or passkey page); possession of this request is not approval' });
    d.validate(inspection);
    if (row.state === 'prepared') this.journal.transition(id, 'prepared', 'approved');
    d.authorize(inspection);
    const fenced = d.rateLimit ? this.journal.claim(id, d.rateLimit(), this.now()) : this.journal.transition(id, 'approved', 'sending');
    if (!fenced) throw d.unknown();
    try {
      const output = await d.execute(inspection);
      if (!d.valid(output)) throw d.unknown();
      const messageId = d.messageId(output);
      if (!this.journal.transition(id, 'sending', d.done, messageId)) throw d.unknown();
      return d.result({ ...row, state: d.done, message_id: messageId }, output);
    } catch (error) {
      const notApplied = d.notApplied?.(error);
      if (notApplied) {
        // Nothing reached the account: the approved operation can be committed again with the same requestId.
        let restored = false;
        try { restored = this.journal.transition(id, 'sending', 'approved'); } catch { /* recorded as uncertain below */ }
        if (restored) throw notApplied;
      }
      // A provider effect may already have happened, including when persisting its result failed.
      try { this.journal.transition(id, 'sending', d.uncertain); }
      catch { process.stderr.write('[operation-engine] outcome not persisted; durable attempt needs manual review\n'); }
      const settled = await this.settle(id, d);
      if (settled?.state === d.done) return d.result(settled);
      if (settled) throw new KakaoError('SEND_NOT_DELIVERED', 'The message was not delivered; send again with the same requestId', { retryable: true });
      throw d.unknown();
    }
  }
}
