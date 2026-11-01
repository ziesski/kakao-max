// ----------------------------------------------------------------------------
// Typed errors for every adapter (MCP, CLI, bots).
//
// A KakaoError carries a stable machine-readable `code`, whether retrying the
// same call can succeed (`retryable`), and optional `details`. Adapters surface
// these to agents so they can react (wait and retry, ask the operator, give up)
// instead of parsing free-form messages.
// ----------------------------------------------------------------------------

import { isLocoError } from '@kakao-max/protocol';
import { setupCommand } from './entry.ts';

export type KakaoErrorCode =
  | 'SESSION_DENIED' // browser session, ownership or CSRF verification failed
  | 'STORAGE_UNSAFE' // encrypted account storage is not verified
  | 'INVALID_ARGUMENT' // the caller passed something malformed or missing
  | 'NOT_FOUND' //        friend / chat / file does not exist
  | 'NOT_CONNECTED' //    the LOCO session is down (reconnecting); retry later
  | 'PC_SESSION_CONFLICT' // another PC session owns the account; no automatic takeover
  | 'AUTH_EXPIRED' //     credentials rejected and could not be refreshed
  | 'POLICY_DENIED' //    room content or outbound policy refused the operation
  | 'RATE_LIMITED' //     a read or outbound budget refused the operation
  | 'LOCO_STATUS' //      the Kakao server answered a command with a non-zero status
  | 'NETWORK' //          HTTP/socket failure talking to Kakao
  | 'CONFIG_INVALID' //   local configuration is missing or malformed
  | 'NOT_IMPLEMENTED' //  a supported surface awaits required protocol evidence
  | 'IDEMPOTENCY_CONFLICT' // request identity is already bound to different immutable input
  | 'APPROVAL_REQUIRED' // signed approval by the configured trusted operator is missing/invalid
  | 'OPERATION_STALE' // approved context or policy changed; prepare a fresh reviewed operation
  | 'OPERATION_EXPIRED' // approval expired before an attempt
  | 'MUTATION_OUTCOME_UNKNOWN' // a mutation may have occurred; manual resolution, never automatic repetition
  | 'SEND_OUTCOME_UNKNOWN' // publication may have succeeded; check history before retry
  | 'SEND_NOT_DELIVERED' // history shows an attempted send never arrived; the same requestId may be sent again
  | 'CURSOR_CONFLICT' // another collector advanced the durable source checkpoint
  | 'LEASE_CONFLICT' // event lease expired, changed owner or was superseded
  | 'HISTORY_CONFLICT' // incompatible records for the same history revision
  | 'ROOM_NOT_READ' // room unread count is nonzero or cannot be confirmed
  | 'WORKER_IN_USE' // a worker owns the account or its shutdown is uncertain
  | 'INTERNAL'; //        a bug or an unexpected condition


const RETRYABLE_BY_DEFAULT: ReadonlySet<KakaoErrorCode> = new Set(['NOT_CONNECTED', 'RATE_LIMITED', 'NETWORK']);

export class KakaoError extends Error {
  readonly code: KakaoErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: KakaoErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'KakaoError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (opts.details) this.details = opts.details;
  }

  toJSON(): { code: KakaoErrorCode; message: string; retryable: boolean; details?: Record<string, unknown>; recovery?: { action: string; message: string } } {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}), ...(recoveryAdvice(this.code) ? { recovery: recoveryAdvice(this.code) } : {}) };
  }
}

/** Safe next steps, without relaxing room or account policy. */
export function recoveryAdvice(code: KakaoErrorCode): { action: string; message: string } | undefined {
  switch (code) {
    case 'AUTH_EXPIRED': return { action: 'repair_saved_login', message: `On the managed server run ${setupCommand('--repair')}. Keep the registered device; never automatically force login or re-register.` };
    case 'PC_SESSION_CONFLICT': return { action: 'ask_account_owner', message: 'Another PC may own the account. Keep its connection and ask the person; do not retry with forced login.' };
    case 'NOT_CONNECTED':
    case 'NETWORK': return { action: 'diagnose_connection', message: `The connector reconnects automatically. If unavailable, run ${setupCommand('--doctor')} with the same --listen/--ssh settings. Never replay an uncertain mutation.` };
    case 'ROOM_NOT_READ': return { action: 'inspect_room_read_state', message: 'Refresh get_room_access metadata. Message access and marking read require separate permissions; never mark read automatically.' };
    case 'POLICY_DENIED': return { action: 'review_scope_with_person', message: 'Inspect the policy and room access. Request only the scope the person asked for through the client approval flow.' };
    case 'SEND_NOT_DELIVERED': return { action: 'retry_same_request', message: 'The room history shows this message never arrived. Call the same tool again with the same requestId to send it.' };
    case 'SEND_OUTCOME_UNKNOWN': return { action: 'inspect_existing_operation', message: 'The daemon checks the room history after reconnecting; call the same tool again with the same requestId to see the settled outcome. Never invent a replacement ID.' };
    case 'MUTATION_OUTCOME_UNKNOWN': return { action: 'inspect_existing_operation', message: 'Inspect the operation with its existing requestId; never invent a replacement ID or automatically resend.' };
    default: return undefined;
  }
}

/** A LOCO command answered with a non-zero status. */
export function locoStatusError(command: string, status: number): KakaoError {
  return new KakaoError('LOCO_STATUS', `${command} failed with status ${status}`, { details: { command, status } });
}

/** LOCO statuses that mean the credentials were rejected. */
const AUTH_STATUSES = new Set([-950]);

/** Normalize anything thrown into a KakaoError (unknown errors become INTERNAL). */
export function toKakaoError(e: unknown): KakaoError {
  if (e instanceof KakaoError) return e;
  if (isLocoError(e)) {
    const details = { ...(e.command ? { command: e.command } : {}), ...(e.status !== undefined ? { status: e.status } : {}), locoCode: e.code };
    switch (e.code) {
      case 'AMBIGUOUS_WRITE':
        return new KakaoError('SEND_OUTCOME_UNKNOWN', e.message, { details, retryable: false, cause: e });
      case 'NOT_CONNECTED':
      case 'CLOSED':
        return new KakaoError('NOT_CONNECTED', e.message, { details, cause: e });
      case 'TIMEOUT':
      case 'UNREACHABLE':
        return new KakaoError('NETWORK', e.message, { details, cause: e });
      case 'STATUS':
        return new KakaoError(e.status !== undefined && AUTH_STATUSES.has(e.status) ? 'AUTH_EXPIRED' : 'LOCO_STATUS', e.message, { details, cause: e });
      case 'INVALID_ARGUMENT':
        return new KakaoError('INVALID_ARGUMENT', e.message, { details, cause: e });
      case 'MALFORMED':
        return new KakaoError('INTERNAL', 'Kakao returned a malformed protocol response', { details, cause: e });
      default:
        return new KakaoError('INTERNAL', 'Unexpected protocol error', { details, cause: e });
    }
  }
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
    return new KakaoError('NETWORK', 'Kakao network connection failed', { details: { systemCode: code }, cause: err });
  }
  // Unexpected exceptions may contain response bodies, paths or SQL parameters. Keep the
  // cause for in-process debugging, but never serialize it to clients or diagnostic logs.
  return new KakaoError('INTERNAL', 'Unexpected internal error', { cause: err });
}
