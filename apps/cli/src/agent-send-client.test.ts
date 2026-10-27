import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendMessage, sendPhotos, submitWrite, approvalLink, type AgentToolClient } from './agent-send-client.ts';
import { readAgentRequest, runAgentFileCommand, agentFileTool } from './agent-send-files.ts';
import { McpToolError } from './mcp-client.ts';
import { KakaoError } from '@kakao-max/core';

const approvalNeeded = (tool: string) => new McpToolError(tool, 'Human approval is required', 'APPROVAL_REQUIRED', false,
  { approval: { requestId: 'x' }, passkey: { approvalUrl: 'https://approve.example.test/a/x#token' } });

test('one call per write with one stable identity; approval-needed errors pass through with the passkey link', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []; let personal = false;
  const client = { callTool: async (name: string, args: any) => {
    calls.push({ name, args });
    if (personal) throw approvalNeeded(name);
    return { status: 0, state: 'sent_unverified', logId: '9007199254740993', requestId: args.requestId };
  } } as AgentToolClient;
  const id = randomUUID(), message = { chatId: '123456789', text: 'fixture' };
  assert.equal((await sendMessage(client, message, id)).logId, '9007199254740993');
  assert.deepEqual(calls.map(c => c.name), ['send_message']); assert.equal(calls[0].args.requestId, id);
  await sendPhotos(client, { chatId: '123456789', type: 18, fileName: 'fixture.bin', dataBase64: 'AQID' }, id);
  assert.equal(calls[1].name, 'send_photos');
  personal = true;
  const err = await sendMessage(client, message).catch(e => e);
  assert.equal(err.code, 'APPROVAL_REQUIRED'); assert.equal(approvalLink(err), 'https://approve.example.test/a/x#token');
  assert.equal(calls.length, 3);
});

test('lost responses and malformed acknowledgements are uncertain, non-retryable and never trigger another attempt', async () => {
  for (const [kind, mode] of [['send', 'disconnect'], ['send', 'bad-result'], ['send', 'numeric-id'], ['mutation', 'disconnect'], ['mutation', 'bad-result'], ['operation', 'disconnect']] as const) {
    let calls = 0; const id = randomUUID();
    const client = { callTool: async () => {
      calls++;
      if (mode === 'disconnect') throw new Error('fixture disconnected after write');
      return { status: 0, state: kind === 'send' ? 'sent_unverified' : 'unexpected', requestId: id, logId: mode === 'numeric-id' ? Number('9007199254740993') : undefined };
    } } as AgentToolClient;
    await assert.rejects(submitWrite(client, 'fixture_tool', { requestId: id }, kind),
      { code: kind === 'send' ? 'SEND_OUTCOME_UNKNOWN' : 'MUTATION_OUTCOME_UNKNOWN', retryable: false, details: { requestId: id } });
    assert.equal(calls, 1, `${kind}/${mode}`);
  }
  const denied = { callTool: async () => { throw new McpToolError('send_message', 'fixture denied', 'POLICY_DENIED'); } } as AgentToolClient;
  await assert.rejects(submitWrite(denied, 'send_message', { requestId: randomUUID() }, 'send'), { code: 'POLICY_DENIED' });
});

test('request files stay exact, bounded and private, and map each action to its single-call tool', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'request.json');
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const id = randomUUID();
  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [{ requestId: id, chatId: '9007199254740993', text: 'fixture 가 ' }, 'send_message', { requestId: id, chatId: '9007199254740993', text: 'fixture 가 ' }],
    [{ action: 'send_media', requestId: id, chatId: '123456789', type: 18, fileName: 'fixture.bin', dataBase64: 'AQID' }, 'send_photos',
      { requestId: id, chatId: '123456789', type: 18, fileName: 'fixture.bin', dataBase64: 'AQID' }],
    [{ action: 'delete_message', requestId: id, chatId: '123456789', logId: '9' }, 'edit_or_delete_message', { requestId: id, action: 'delete', chatId: '123456789', logId: '9' }],
    [{ action: 'update_my_profile', requestId: id, profileId: '123456789', statusMessage: '' }, 'update_my_profile', { requestId: id, profileId: '123456789', statusMessage: '' }],
    [{ action: 'grant_room_access', requestId: id, chatId: '123456789', rule: { mode: 'manual', maxMessages: 5 } }, 'request_permission',
      { requestId: id, type: 'room_access', chatId: '123456789', rule: { maxMessages: 5, mode: 'manual' } }],
    [{ action: 'allow_recipient', requestId: id, chatId: '123456789' }, 'request_permission', { requestId: id, type: 'send', chatId: '123456789' }],
    [{ action: 'leave_chat', requestId: id, chatId: '123456789' }, 'leave_chat', { requestId: id, chatId: '123456789', block: false, silence: false }],
    [{ action: 'resume_sending', requestId: id }, 'pause', { requestId: id, paused: false }]
  ];
  for (const [input, tool, args] of cases) {
    write(input);
    const mapped = agentFileTool(readAgentRequest(file));
    assert.equal(mapped.tool, tool, JSON.stringify(input)); assert.deepEqual(mapped.args, args, JSON.stringify(input));
  }
  write(cases[0][0]);
  const calls: any[] = [];
  const client = { callTool: async (name: string, args: any) => { calls.push({ name, args }); return { status: 0, requestId: args.requestId, logId: '9007199254740993', state: 'sent_unverified' }; } } as AgentToolClient;
  await runAgentFileCommand(client, file); await runAgentFileCommand(client, file);
  assert.deepEqual(calls.map(c => c.name), ['send_message', 'send_message']); assert.equal(calls[0].args.requestId, calls[1].args.requestId);
  for (const bad of [{ ...cases[0][0], chatId: 9007199254740993 }, { ...cases[1][0], filePath: '/private/secret' }, { action: 'resume_sending', requestId: id, confirm: true },
    { ...cases[0][0], approvalSignature: 'fixture' }]) {
    write(bad); assert.throws(() => readAgentRequest(file), { code: 'INVALID_ARGUMENT' }, JSON.stringify(bad));
  }
  if (process.platform !== 'win32') { write(cases[0][0]); fs.chmodSync(file, 0o644); assert.throws(() => readAgentRequest(file), { code: 'INVALID_ARGUMENT' }); }
});

for (const [command, extra] of [['send', ['fixture']], ['send-file', ['FILE']]] as const) {
  test(`kakao ${command} to a room the person has not allowed prints the approval link and exits nonzero without sending`, async t => {
    const { spawn } = await import('node:child_process');
    const net = await import('node:net');
    const { McpStdioServer } = await import('../../mcp/src/mcp-stdio.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-approval-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'fixture.bin'); fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    const server = new McpStdioServer({ name: 'fixture', version: '1' });
    server.registerTool({ name: 'get_status', description: 'fixture', inputSchema: { type: 'object' }, handler: () => ({ connected: true, userId: '123456789' }) });
    server.registerTool({ name: 'list_chats', description: 'fixture', inputSchema: { type: 'object' }, handler: () => ({ chats: [{ id: '123456789', type: 'MemoChat', title: 'fixture self' }] }) });
    let attempts = 0;
    for (const name of ['send_message', 'send_photos']) server.registerTool({ name, description: 'fixture', inputSchema: { type: 'object' }, handler: () => {
      attempts++;
      throw new KakaoError('APPROVAL_REQUIRED', 'Human approval is required', { details: { passkey: { approvalUrl: 'https://approve.example.test/a/x#t' } } });
    } });
    const listener = net.createServer(socket => server.serveConnection(socket, socket));
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
    const port = (listener.address() as import('node:net').AddressInfo).port;
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url)), command, 'self', ...extra.map(a => a === 'FILE' ? file : a)],
      { env: { PATH: process.env.PATH, MCP_HOST: '127.0.0.1', MCP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture CLI timeout')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', c => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1); assert.equal(attempts, 1);
    assert.match(output, /승인 필요/); assert.match(output, /approve\.example\.test/); assert.match(output, /--request-id [0-9a-f-]{36}/);
  });
}
