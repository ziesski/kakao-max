import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AgentSendJournal, AgentSendService, ApprovalStore, ApproverRegistry, RecipientPermissions, SendPolicy } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { ElicitationApprovals, approvalMessage } from './client-approval.ts';
import { registerAgentMessageTools } from './tools/agent-messages.ts';

const V = '2026-07-28';
const meta = (opts: { version?: string; elicitation?: boolean; client?: string } = {}) => ({
  'io.modelcontextprotocol/protocolVersion': opts.version ?? V,
  'io.modelcontextprotocol/clientInfo': { name: opts.client ?? 'Fixture Client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': opts.elicitation === false ? {} : { elicitation: {} }
});

function connect(server: McpStdioServer, t: { after(fn: () => void): void }, onInput?: (request: any) => void) {
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.end(); output.end(); });
  let id = 0, text = '';
  const pending = new Map<number, (value: any) => void>();
  output.on('data', chunk => {
    text += chunk.toString(); let n;
    while ((n = text.indexOf('\n')) >= 0) { const r = JSON.parse(text.slice(0, n)); text = text.slice(n + 1); if (r.method === 'elicitation/create') onInput?.(r); else { pending.get(r.id)?.(r); pending.delete(r.id); } }
  });
  server.serveConnection(input, output);
  const call = (method: string, params: Record<string, unknown> = {}) => new Promise<any>(resolve => {
    const next = ++id; pending.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  });
  return Object.assign(call, { end: () => input.end(), respond: (id: string, result: unknown) => input.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') });
}

test('legacy connections keep the initialize-era contract; modern requests are served statelessly per request', async t => {
  const server = new McpStdioServer({ name: 'test', version: '0', instructions: 'fixture' });
  server.registerTool({ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { v: { type: 'string' } }, additionalProperties: false }, handler: a => ({ v: a.v }) });

  const modern = connect(server, t);
  const discover = (await modern('server/discover', { _meta: meta() })).result;
  assert.deepEqual(discover.supportedVersions, [V]); assert.equal(discover.resultType, 'complete');
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'test'); assert.equal(discover.instructions, 'fixture');
  const list = (await modern('tools/list', { _meta: meta() })).result;
  assert.equal(list.resultType, 'complete'); assert.equal(list.tools[0].name, 'echo'); assert.equal(typeof list.ttlMs, 'number'); assert.equal(list.cacheScope, 'private');
  const call = (await modern('tools/call', { _meta: meta(), name: 'echo', arguments: { v: 'x' } })).result;
  assert.equal(call.resultType, 'complete'); assert.equal(call.isError, false);
  const unsupported = (await modern('tools/list', { _meta: meta({ version: '1900-01-01' }) })).error;
  assert.equal(unsupported.code, -32022); assert.equal(unsupported.data.requested, '1900-01-01'); assert.ok(unsupported.data.supported.includes(V));
  assert.equal((await modern('ping', { _meta: meta() })).error.code, -32601); // removed in 2026-07-28

  const legacy = connect(server, t);
  const init = (await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } })).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  const legacyList = (await legacy('tools/list', { _meta: meta() })).result; // initialize pins legacy semantics on this connection
  assert.equal(legacyList.resultType, undefined); assert.equal(legacyList.ttlMs, undefined);
  assert.deepEqual((await legacy('ping')).result, {});
  // A legacy client that skips initialize and sends no _meta is still served as before.
  assert.equal((await connect(server, t)('tools/list')).result.resultType, undefined);
});

const codeOf = (ask: any): string => /확인 코드 ([A-Z2-9]{4})/.exec(ask.inputRequests.approve.params.message)![1];
const accept = (code: string, remember?: boolean) => ({ approve: { action: 'accept', content: { code, ...(remember !== undefined ? { remember } : {}) } } });

function approvalFixture(t: { after(fn: () => void): void }, clientConfirmations = true, withRecipients = false, roomPermissions = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-modern-'));
  const journal = AgentSendJournal.open(root), store = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations });
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let sends = 0;
  const recipients = withRecipients ? new RecipientPermissions(journal, { dailyLimit: 1, timeZone: 'Asia/Seoul' }) : undefined;
  const policy = new SendPolicy({ ceiling: roomPermissions ? [] : ['123456789'], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  const service = new AgentSendService({ principal: 'local-mcp', journal, approvals: store, recipients: recipients,
    policy,
    adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture', send: async () => { sends++; return { status: 0, logId: '9007199254740993' }; } } });
  const server = new McpStdioServer({ name: 'test', version: '0' });
  server.setClientApproval(new ElicitationApprovals(store, Date.now, recipients));
  registerAgentMessageTools(server, () => service);
  return { service, store, server, recipients, sends: () => sends };
}

test('a commit without approval asks the person through a form elicitation and runs only after they accept', async t => {
  const f = approvalFixture(t), call = connect(f.server, t), requestId = randomUUID();
  const args = { requestId, chatId: '123456789', text: '내일 3시에 봬요\u202Egnp.exe' };
  f.service.prepare(requestId, { chatId: args.chatId, text: args.text });

  const ask = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args })).result;
  assert.equal(ask.resultType, 'input_required'); assert.equal(f.sends(), 0);
  const form = ask.inputRequests.approve;
  assert.equal(form.method, 'elicitation/create'); assert.equal(form.params.mode, 'form');
  assert.match(form.params.message, /메시지 보내기 승인 요청/); assert.match(form.params.message, /⟦U\+202E⟧/);
  assert.match(form.params.message, /에이전트가 작성했습니다/);
  assert.deepEqual(form.params.requestedSchema.required, ['code']); assert.equal(form.params.requestedSchema.properties.remember, undefined);
  const ok = accept(codeOf(ask));

  // Sealed state is bound to the same tool, arguments and client.
  const tampered = ask.requestState.slice(0, -2) + (ask.requestState.endsWith('AA') ? 'BB' : 'AA');
  for (const [p, label] of [[{ arguments: args, requestState: tampered }, 'tampered'], [{ arguments: { ...args, text: '다른 내용' }, requestState: ask.requestState }, 'changed args'],
    [{ arguments: args, requestState: ask.requestState, _meta: meta({ client: 'other' }) }, 'other client']] as const) {
    const r = (await call('tools/call', { _meta: meta(), name: 'send_message', inputResponses: ok, ...p })).result;
    assert.equal(r.isError, true, label); assert.equal(r.structuredContent.error.code, 'APPROVAL_REQUIRED', label);
  }
  assert.equal(f.store.state(requestId), 'awaiting_approval'); assert.equal(f.sends(), 0);

  const cancelled = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args, requestState: ask.requestState, inputResponses: { approve: { action: 'cancel' } } })).result;
  assert.equal(cancelled.structuredContent.error.code, 'APPROVAL_REQUIRED'); assert.equal(f.store.state(requestId), 'awaiting_approval');

  // A reflexive Enter (no code) or a wrong code approves nothing and shows the dialog again with a new code.
  let current = ask;
  for (const bad of [{ approve: { action: 'accept', content: {} } }, accept(''), accept('ZZZZ'), { approve: { action: 'accept', content: { approve: true } } }]) {
    const again = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args, requestState: current.requestState, inputResponses: bad })).result;
    assert.equal(again.resultType, 'input_required', JSON.stringify(bad)); assert.equal(f.sends(), 0);
    current = again;
  }
  assert.equal(f.store.state(requestId), 'awaiting_approval');
  const done = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args, requestState: current.requestState, inputResponses: accept(codeOf(current).toLowerCase()) })).result;
  assert.equal(done.resultType, 'complete'); assert.equal(done.isError, false); assert.equal(JSON.parse(done.content[0].text).state, 'sent_unverified');
  assert.equal(f.sends(), 1);
});

test('decline rejects the operation; clients without elicitation and disabled confirmations get the plain error', async t => {
  const f = approvalFixture(t), call = connect(f.server, t);
  const declinedId = randomUUID(), args = { requestId: declinedId, chatId: '123456789', text: 'fixture' };
  f.service.prepare(declinedId, { chatId: args.chatId, text: args.text });
  const ask = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args })).result;
  const declined = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args, requestState: ask.requestState, inputResponses: { approve: { action: 'decline' } } })).result;
  assert.equal(declined.structuredContent.error.code, 'POLICY_DENIED'); assert.equal(f.store.state(declinedId), 'rejected');

  const id2 = randomUUID(), args2 = { requestId: id2, chatId: '123456789', text: 'fixture 2' };
  f.service.prepare(id2, { chatId: args2.chatId, text: args2.text });
  const noForm = (await call('tools/call', { _meta: meta({ elicitation: false }), name: 'send_message', arguments: args2 })).result;
  assert.equal(noForm.isError, true); assert.equal(noForm.structuredContent.error.code, 'APPROVAL_REQUIRED');
  assert.equal(noForm.structuredContent.error.details.approval.requestId, id2);
  const legacy = connect(f.server, t);
  await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal((await legacy('tools/call', { name: 'send_message', arguments: args2 })).result.isError, true);
  assert.equal(f.sends(), 0);

  const off = approvalFixture(t, false), offCall = connect(off.server, t), id3 = randomUUID(), args3 = { requestId: id3, chatId: '123456789', text: 'fixture 3' };
  off.service.prepare(id3, { chatId: args3.chatId, text: args3.text });
  const offAsk = (await offCall('tools/call', { _meta: meta(), name: 'send_message', arguments: args3 })).result;
  const offRetry = (await offCall('tools/call', { _meta: meta(), name: 'send_message', arguments: args3, requestState: offAsk.requestState,
    inputResponses: accept(codeOf(offAsk)) })).result;
  assert.equal(offRetry.structuredContent.error.code, 'APPROVAL_REQUIRED'); assert.equal(off.sends(), 0);
});

test('binary publications and oversized drafts are never approved from a text dialog', () => {
  const envelope = (action: string, message: unknown) => JSON.stringify({ action, accountId: '1', requestId: randomUUID(), message });
  assert.equal(approvalMessage(envelope('send_media', { chatId: '1', sha256: 'a'.repeat(64), type: 2 })), undefined);
  assert.equal(approvalMessage(envelope('send_photo_bundle', { chatId: '1', photos: [] })), undefined);
  assert.equal(approvalMessage(envelope('send_message', { chatId: '1', text: 'x'.repeat(4000) })), undefined);
  assert.match(approvalMessage(envelope('leave_chat', { chatId: '1', silence: false, block: false }))!, /방 나가기 승인 요청/);
});

test('a photo send asks for the room\'s send permission, granted only with the right code', () => {
  const confirmed: string[] = [], granted: string[] = [];
  const store = { envelopeDigest: () => 'fixture-digest', reject: () => {}, recordClientConfirmation: (id: string) => { confirmed.push(id); } };
  const recipients = { grant: (chatId: string) => { granted.push(chatId); } };
  const client = { name: 'fixture-client', elicitation: true };
  for (const [action, message] of [['send_media', { chatId: '123456789', sha256: 'a'.repeat(64), type: 2 }], ['send_photo_bundle', { chatId: '123456789', photos: [] }]] as const) {
    confirmed.length = 0; granted.length = 0;
    const args = { requestId: 'fixture-request', chatId: '123456789' };
    const approval = { requestId: 'fixture-request', signingText: JSON.stringify({ action, accountId: '1', requestId: 'fixture-request', message }), expiresAt: Date.now() + 60_000 };
    assert.equal(new ElicitationApprovals(store as never).request(action, args, approval, client), undefined, `${action}: no room permission to offer`);
    const gate = new ElicitationApprovals(store as never, Date.now, recipients as never);
    const ask = gate.request(action, args, approval, client)!;
    const form = ask.inputRequests.approve.params as any;
    assert.match(form.message, /대화방 메시지·사진 전송 허가 승인 요청/);
    assert.match(form.message, /사진은 확인 창에 보여 줄 수 없어/);
    assert.deepEqual(Object.keys(form.requestedSchema.properties), ['code'], `${action}: accepting is the room permission itself`);
    assert.equal(gate.answer(action, args, ask.requestState, { approve: { action: 'accept', content: { code: '' } } }, client), 'mismatch');
    assert.deepEqual(granted, []);
    assert.equal(gate.answer(action, args, ask.requestState, accept(codeOf(ask)), client), 'approved');
    assert.deepEqual(granted, ['123456789']); assert.deepEqual(confirmed, ['fixture-request']);
  }
});

for (const roomPermissions of [false, true]) test(`assistant profile: first-send permission, later sends and revocation (rooms=${roomPermissions})`, async t => {
  const f = approvalFixture(t, true, true, roomPermissions), call = connect(f.server, t);
  const send = async (text: string) => {
    const requestId = randomUUID(), args = { requestId, chatId: '123456789', text };
    const prepared = f.service.prepare(requestId, { chatId: args.chatId, text });
    return { args, prepared, result: (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args })).result };
  };
  const first = await send('처음 보내는 메시지');
  assert.equal(first.prepared.approvalRequired, true); assert.equal(first.result.resultType, 'input_required');
  assert.equal(first.result.inputRequests.approve.params.requestedSchema.properties.remember.default, false);
  // "Don't ask again" without the right code allows nothing.
  const noCode = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: first.args, requestState: first.result.requestState,
    inputResponses: { approve: { action: 'accept', content: { remember: true } } } })).result;
  assert.equal(noCode.resultType, 'input_required'); assert.equal(f.recipients!.list().length, 0);
  const done = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: first.args, requestState: noCode.requestState,
    inputResponses: accept(codeOf(noCode), true) })).result;
  assert.equal(done.isError, false); assert.equal(f.recipients!.get('123456789')!.approver, 'client:fixture-client');

  const second = await send('두 번째는 바로');
  assert.equal(second.prepared.approvalRequired, false); assert.equal(second.result.resultType, 'complete'); assert.equal(second.result.isError, false);
  const third = await send('세 번째: 허용 사용 하루 한도 1 초과');
  assert.equal(third.prepared.approvalRequired, true); assert.equal(third.result.resultType, 'input_required');
  assert.equal(f.sends(), 2);
  assert.equal(f.recipients!.revoke('123456789'), true);
  const afterRevoke = await send('철회 뒤에는 다시 확인');
  assert.equal(afterRevoke.prepared.approvalRequired, true); assert.equal(afterRevoke.result.resultType, 'input_required');
  const declined = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: afterRevoke.args,
    requestState: afterRevoke.result.requestState, inputResponses: { approve: { action: 'decline' } } })).result;
  assert.equal(declined.structuredContent.error.code, 'POLICY_DENIED');
  assert.equal(f.recipients!.list().length, 0); assert.equal(f.sends(), 2);
});

test('a first-send client confirmation can approve only that message without creating a standing permission', async t => {
  const f = approvalFixture(t, true, true, true), call = connect(f.server, t);
  const args = { requestId: randomUUID(), chatId: '123456789', text: '한 번만' };
  f.service.prepare(args.requestId, { chatId: args.chatId, text: args.text });
  const ask = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args })).result;
  assert.equal(ask.resultType, 'input_required'); assert.equal(f.sends(), 0);
  const accepted = (await call('tools/call', { _meta: meta(), name: 'send_message', arguments: args,
    requestState: ask.requestState, inputResponses: accept(codeOf(ask)) })).result;
  assert.equal(accepted.isError, false); assert.equal(f.sends(), 1); assert.equal(f.recipients!.list().length, 0);
  const next = { ...args, requestId: randomUUID() };
  assert.equal(f.service.prepare(next.requestId, { chatId: next.chatId, text: next.text }).approvalRequired, true);
  assert.equal((await call('tools/call', { _meta: meta(), name: 'send_message', arguments: next })).result.resultType, 'input_required');
  assert.equal(f.sends(), 1);
});


test('initialize clients receive a nested human confirmation and replay a single acknowledged send', async t => {
  for (const version of ['2025-06-18', '2025-11-25']) {
    const f = approvalFixture(t, true, true, true), args = { requestId: randomUUID(), chatId: '123456789', text: 'fixture greeting' };
    let dialogs = 0;
    const call = connect(f.server, t, request => {
      dialogs++;
      assert.equal(f.sends(), 0);
      assert.equal(request.params.mode, version === '2025-11-25' ? 'form' : undefined);
      const code = request.params.requestedSchema.properties.code.description.match(/[A-Z0-9]{4}/)[0];
      call.respond(request.id, { action: 'accept', content: { code } });
    });
    await call('initialize', { protocolVersion: version, capabilities: { elicitation: {} }, clientInfo: { name: 'fixture-client' } });
    f.service.prepare(args.requestId, { chatId: args.chatId, text: args.text });
    const result = await call('tools/call', { name: 'send_message', arguments: args });
    assert.equal(result.result.isError, false); assert.equal(f.sends(), 1); assert.equal(dialogs, 1);
    await call('tools/call', { name: 'send_message', arguments: args });
    assert.equal(f.sends(), 1); assert.equal(dialogs, 1);
  }
});

test('legacy decline, cancel and a wrong or empty code never send or grant a recipient permission', async t => {
  for (const action of ['decline', 'cancel', 'wrong', 'empty']) {
    const f = approvalFixture(t, true, true, true), args = { requestId: randomUUID(), chatId: '123456789', text: 'fixture greeting' };
    const call = connect(f.server, t, request => {
      call.respond(request.id, { action: action === 'wrong' || action === 'empty' ? 'accept' : action,
        content: { code: action === 'wrong' ? 'wrong' : '', remember: true } });
    });
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } });
    f.service.prepare(args.requestId, { chatId: args.chatId, text: args.text });
    const result = await call('tools/call', { name: 'send_message', arguments: args });
    assert.equal(result.result.isError, true); assert.equal(f.sends(), 0);
    assert.equal(result.result.structuredContent.error.code, action === 'decline' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED');
    assert.equal(f.recipients!.list().length, 0);
  }
});

test('legacy dialog replies are bound to their connection, and closing a pending client cancels safely', async t => {
  const f = approvalFixture(t), args = { requestId: randomUUID(), chatId: '123456789', text: 'fixture greeting' };
  let sawDialog!: (request: any) => void;
  const dialog = new Promise<any>(resolve => { sawDialog = resolve; });
  const first = connect(f.server, t, sawDialog), other = connect(f.server, t);
  for (const call of [first, other]) await call('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'same-name' } });
  f.service.prepare(args.requestId, { chatId: args.chatId, text: args.text });
  const pending = first('tools/call', { name: 'send_message', arguments: args });
  const request = await dialog, code = request.params.requestedSchema.properties.code.description.match(/[A-Z0-9]{4}/)[0];
  other.respond(request.id, { action: 'accept', content: { code } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sends(), 0);
  first.end();
  assert.equal((await pending).result.isError, true); assert.equal(f.sends(), 0);
});

