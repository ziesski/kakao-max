import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpToolError, McpTransportError } from './mcp-bridge.ts';
import { isRequestId, writeFailure } from './write-request.ts';

test('the server accepts only a UUID requestId chosen by the page, never inventing one', () => {
  assert.equal(isRequestId('00000000-0000-4000-8000-000000000001'), true);
  for (const bad of [undefined, '', 'abc', 42, '00000000-0000-4000-8000-00000000000Z', '00000000-0000-4000-8000-000000000001\n', 'AAAAAAAA-0000-4000-8000-000000000001'])
    assert.equal(isRequestId(bad), false, String(bad));
});

test('a lost connection, timeout or protocol error mid-call is an unknown outcome with a stable code', () => {
  for (const code of ['CONNECTION_LOST', 'TIMEOUT', 'RPC_ERROR'] as const) {
    const { status, body } = writeFailure(new McpTransportError(code, 'x'), 'r');
    assert.equal(status, 504); assert.equal(body.code, code); assert.equal(body.uncertain, true); assert.equal(body.requestId, 'r');
  }
  const offline = writeFailure(new McpTransportError('DAEMON_NOT_CONNECTED', 'x'));
  assert.equal(offline.body.uncertain, false, 'nothing reached the daemon');
});

test('the daemon\'s outcome-unknown codes stay unknown; refusals and approvals do not', () => {
  for (const code of ['SEND_OUTCOME_UNKNOWN', 'MUTATION_OUTCOME_UNKNOWN']) assert.equal(writeFailure(new McpToolError('x', code)).body.uncertain, true);
  const approval = writeFailure(new McpToolError('x', 'APPROVAL_REQUIRED', 'https://approve.example/p'));
  assert.equal(approval.status, 403); assert.equal(approval.body.uncertain, false); assert.equal(approval.body.approvalUrl, 'https://approve.example/p');
  const denied = writeFailure(new McpToolError('x', 'POLICY_DENIED'));
  assert.equal(denied.status, 502); assert.equal(denied.body.code, 'POLICY_DENIED'); assert.equal(denied.body.uncertain, false);
  assert.equal(writeFailure(new McpToolError('x', 'RATE_LIMITED', undefined, true)).body.retryable, true);
  // An unexpected error is never reported as "not sent".
  assert.deepEqual([writeFailure(new Error('boom')).body.code, writeFailure(new Error('boom')).body.uncertain], ['OUTCOME_UNKNOWN', true]);
});

test('the page keeps one requestId per action until its outcome is known', async () => {
  // Classic browser script: it sets globalThis.KakaoWrites.
  await import(fileURLToPath(new URL('../public/write-intents.js', import.meta.url)) as string);
  const { WriteIntents, intentKey } = (globalThis as any).KakaoWrites;
  let n = 0;
  const intents = new WriteIntents(() => `id-${++n}`);
  const send = intentKey('send', { chatId: '1', text: 'hello' });

  const first = intents.idFor(send);
  assert.equal(intents.settle(send, { uncertain: true, code: 'CONNECTION_LOST' }), 'uncertain');
  assert.equal(intents.idFor(send), first, 'retry after an unknown outcome reuses the same requestId');
  assert.equal(intents.settle(send, { code: 'APPROVAL_REQUIRED' }), 'approval');
  assert.equal(intents.idFor(send), first, 'continuing after approval reuses it too');
  assert.equal(intents.settle(send), 'done');
  assert.notEqual(intents.idFor(send), first, 'the next identical message after a confirmed send is a new action');

  const del = intentKey('delete', { chatId: '1', logId: '9' });
  const d1 = intents.idFor(del);
  assert.equal(intents.settle(del, { code: 'POLICY_DENIED' }), 'failed');
  assert.notEqual(intents.idFor(del), d1, 'a definite refusal frees the action for a new decision');
  assert.notEqual(intents.idFor(intentKey('send', { chatId: '1', text: 'other' })), intents.idFor(send), 'different text, different action');
});
