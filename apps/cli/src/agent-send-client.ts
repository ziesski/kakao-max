// Client orchestration only; authorization and durable attempts remain in core.
import { McpToolError } from './mcp-client.ts';
import { randomUUID } from 'node:crypto';
import { KakaoError, type AgentMessage, type AgentPublicationInput } from '@kakao-max/core';
export interface AgentToolClient { callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T>; }

/** Errors that prove the daemon made no external attempt; everything else may follow a side effect. */
const NO_ATTEMPT = ['APPROVAL_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'OPERATION_EXPIRED', 'OPERATION_STALE', 'POLICY_DENIED', 'RATE_LIMITED',
  'NOT_CONNECTED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'ROOM_NOT_READ', 'CONFIG_INVALID'];
type WriteKind = 'send' | 'mutation' | 'operation';
const ID = /^[1-9]\d{0,18}$/;

function acknowledged(kind: WriteKind, out: any, requestId: string): boolean {
  if (!out || out.status !== 0 || out.requestId !== requestId) return false;
  if (kind === 'send') return out.state === 'sent_unverified' && typeof out.logId === 'string' && ID.test(out.logId);
  if (out.logId !== undefined && (typeof out.logId !== 'string' || !ID.test(out.logId))) return false;
  return kind === 'mutation' ? out.state === 'applied_unverified' : ['applied', 'applied_unverified'].includes(out.state);
}

/**
 * One write call with a caller-chosen requestId. Calling again with the same requestId continues it (after approval)
 * or replays its recorded result; there is never an automatic retry or a new ID after an uncertain outcome.
 */
export async function submitWrite(client: AgentToolClient, tool: string, args: { requestId: string; [key: string]: unknown }, kind: WriteKind): Promise<any> {
  try {
    const out = await client.callTool(tool, args);
    if (!acknowledged(kind, out, args.requestId)) throw new Error('Invalid acknowledgement');
    return out;
  } catch (cause) {
    if (cause instanceof McpToolError && NO_ATTEMPT.includes(cause.code)) throw cause;
    // A timeout/disconnect or malformed response may follow a completed side effect.
    throw new KakaoError(kind === 'send' ? 'SEND_OUTCOME_UNKNOWN' : 'MUTATION_OUTCOME_UNKNOWN',
      `Outcome unknown for request ${args.requestId}; inspect Kakao manually and never automatically repeat`,
      { retryable: false, details: { requestId: args.requestId }, cause });
  }
}

/** The passkey link to share when a write is waiting for the person, if the daemon offered one. */
export function approvalLink(error: unknown): string | undefined {
  const url = error instanceof McpToolError ? (error.details?.passkey as { approvalUrl?: unknown } | undefined)?.approvalUrl : undefined;
  return typeof url === 'string' ? url : undefined;
}

export function sendMessage(client: AgentToolClient, message: AgentMessage, requestId: string = randomUUID()) {
  return submitWrite(client, 'send_message', { ...message, requestId }, 'send');
}

export function sendPhotos(client: AgentToolClient, payload: AgentPublicationInput, requestId: string = randomUUID()) {
  return submitWrite(client, 'send_photos', { ...payload, requestId } as { requestId: string }, 'send');
}
