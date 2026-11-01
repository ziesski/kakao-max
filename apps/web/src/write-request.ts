import { McpToolError, McpTransportError } from './mcp-bridge.ts';

// ----------------------------------------------------------------------------
// One write from the page = one requestId the page chose and keeps. The server
// never invents a requestId: a fresh one per HTTP call would turn a retry after
// an uncertain outcome into a second, independent action (a duplicate message).
// ----------------------------------------------------------------------------

/** The daemon's own requestId shape (lowercase UUID). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

/** Daemon codes meaning the action may already have happened. */
const UNCERTAIN_TOOL_CODES: ReadonlySet<string> = new Set(['SEND_OUTCOME_UNKNOWN', 'MUTATION_OUTCOME_UNKNOWN']);

export interface WriteFailureBody {
  error: string;
  /** Always present: a daemon code (APPROVAL_REQUIRED, POLICY_DENIED, …) or a bridge code (CONNECTION_LOST, TIMEOUT, …). */
  code: string;
  /** True when the action may have happened: check the phone, and retry only with the same requestId. */
  uncertain: boolean;
  /** True when the daemon said the same call may succeed later. */
  retryable: boolean;
  requestId?: string;
  approvalUrl?: string;
}

/** HTTP status and JSON body for a failed write. */
export function writeFailure(e: unknown, requestId?: string): { status: number; body: WriteFailureBody } {
  const id = requestId ? { requestId } : {};
  if (e instanceof McpTransportError) {
    return { status: e.uncertain ? 504 : 503, body: { error: e.message, code: e.code, uncertain: e.uncertain, retryable: !e.uncertain, ...id } };
  }
  if (e instanceof McpToolError) {
    const code = e.code || 'TOOL_ERROR';
    const uncertain = UNCERTAIN_TOOL_CODES.has(code);
    return {
      status: code === 'APPROVAL_REQUIRED' ? 403 : uncertain ? 504 : 502,
      body: { error: e.message, code, uncertain, retryable: e.retryable, ...id, ...(e.approvalUrl ? { approvalUrl: e.approvalUrl } : {}) }
    };
  }
  // Anything else happened after the request was accepted: never claim it did not take effect.
  return { status: 504, body: { error: (e as Error)?.message || 'Unknown failure', code: 'OUTCOME_UNKNOWN', uncertain: true, retryable: false, ...id } };
}

export const MISSING_REQUEST_ID: WriteFailureBody = {
  error: 'requestId (a UUID the page keeps for this action) is required', code: 'INVALID_REQUEST_ID', uncertain: false, retryable: false
};
export const NOT_CONNECTED: WriteFailureBody = {
  error: 'Not connected to the daemon; nothing was sent', code: 'DAEMON_NOT_CONNECTED', uncertain: false, retryable: true
};
