import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRelay } from './approval-relay.ts';
import { parseApprovalDialog, type ApprovalAnswer, type ApprovalDialog } from './mcp-bridge.ts';

const dialog = (id = 'approval:1'): ApprovalDialog => ({ id, message: '[kakao-max] 승인 요청', codeTitle: '확인 코드', codeDescription: 'ABCD' });

function relay(viewers = true, timeoutMs?: number) {
  const answers: Array<[string, ApprovalAnswer]> = [], events: Array<[string, unknown]> = [];
  const r = new ApprovalRelay({ answer: (id, a) => { answers.push([id, a]); return true; }, hasViewers: () => viewers, notify: (e, d) => { events.push([e, d]); }, timeoutMs });
  return { r, answers, events };
}

test('with no page open, a dialog is cancelled at once and never shown', () => {
  const { r, answers, events } = relay(false);
  r.request(dialog());
  assert.deepEqual(answers, [['approval:1', { action: 'cancel' }]]);
  assert.deepEqual(events, []); assert.deepEqual(r.list(), []);
});

test('an open page sees the dialog, and the typed code goes back unchanged', () => {
  const { r, answers, events } = relay();
  r.request(dialog());
  assert.deepEqual(events[0], ['approval-request', dialog()]);
  assert.deepEqual(r.list(), [dialog()]);
  assert.equal(r.answerFromPage({ id: 'approval:1', action: 'accept', code: ' abcd ', remember: true }), undefined);
  assert.deepEqual(answers, [['approval:1', { action: 'accept', code: 'abcd', remember: true }]]);
  assert.deepEqual(events.at(-1), ['approval-closed', { id: 'approval:1' }]);
  assert.deepEqual(r.list(), []);
});

test('accept needs a typed code; malformed, unknown and repeated answers send nothing', () => {
  const { r, answers } = relay();
  r.request(dialog());
  assert.match(r.answerFromPage({ id: 'approval:1', action: 'accept' })!, /confirmation code/);
  assert.match(r.answerFromPage({ id: 'approval:1', action: 'accept', code: '   ' })!, /confirmation code/);
  assert.match(r.answerFromPage({ id: 'approval:1', action: 'accept', code: 'x'.repeat(17) })!, /confirmation code/);
  assert.match(r.answerFromPage({ id: 'approval:1', action: 'approve-all' })!, /accept, decline or cancel/);
  assert.match(r.answerFromPage({ id: 'approval:9', action: 'decline' })!, /no longer open/);
  assert.match(r.answerFromPage(undefined)!, /no longer open/);
  assert.deepEqual(answers, []);
  assert.equal(r.answerFromPage({ id: 'approval:1', action: 'decline' }), undefined);
  assert.match(r.answerFromPage({ id: 'approval:1', action: 'accept', code: 'ABCD' })!, /no longer open/, 'one answer per dialog');
  assert.deepEqual(answers, [['approval:1', { action: 'decline' }]]);
});

test('remember is only true when the page sends exactly true', () => {
  const { r, answers } = relay();
  r.request(dialog());
  r.answerFromPage({ id: 'approval:1', action: 'accept', code: 'ABCD', remember: 'yes' });
  assert.deepEqual(answers[0][1], { action: 'accept', code: 'ABCD', remember: false });
});

test('an unanswered dialog is cancelled before the daemon gives up on it', async () => {
  const { r, answers, events } = relay(true, 20);
  r.request(dialog());
  await new Promise(res => setTimeout(res, 60));
  assert.deepEqual(answers, [['approval:1', { action: 'cancel' }]]);
  assert.deepEqual(events.at(-1), ['approval-closed', { id: 'approval:1' }]);
});

test('a dialog the bridge closes (dropped connection) leaves the page', () => {
  const { r, answers, events } = relay();
  r.request(dialog());
  r.closed('approval:1');
  assert.deepEqual(answers, []); assert.deepEqual(r.list(), []);
  assert.deepEqual(events.at(-1), ['approval-closed', { id: 'approval:1' }]);
});

test('only the daemon dialog shape is accepted', () => {
  const schema = (properties: Record<string, unknown>) => ({ mode: 'form', message: 'm', requestedSchema: { type: 'object', properties } });
  const ok = parseApprovalDialog('approval:1', schema({ code: { type: 'string', title: '확인 코드', description: 'd' }, remember: { type: 'boolean', title: 'r' } }));
  assert.deepEqual(ok, { id: 'approval:1', message: 'm', codeTitle: '확인 코드', codeDescription: 'd', rememberTitle: 'r' });
  assert.equal(parseApprovalDialog('a', schema({ code: { type: 'string' } }))?.rememberTitle, undefined);
  assert.equal(parseApprovalDialog('a', { ...schema({ code: { type: 'string' } }), mode: 'url' }), undefined, 'url mode');
  assert.equal(parseApprovalDialog('a', schema({ password: { type: 'string' } })), undefined, 'no code field');
  assert.equal(parseApprovalDialog('a', schema({ code: { type: 'string' }, password: { type: 'string' } })), undefined, 'extra field');
  assert.equal(parseApprovalDialog('a', schema({ code: { type: 'string' }, remember: { type: 'string' } })), undefined);
  assert.equal(parseApprovalDialog(null, schema({ code: { type: 'string' } })), undefined);
  assert.equal(parseApprovalDialog('a', { requestedSchema: {} }), undefined, 'no message');
});
