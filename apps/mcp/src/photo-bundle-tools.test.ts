import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { AgentPublicationService, AgentSendJournal, SendPolicy, type KakaoSession } from '@kakao-max/core';
import { McpStdioServer } from './mcp-stdio.ts';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { agentPublicationAdapter, registerAgentPublicationTools } from './tools/agent-publications.ts';

function png(width = 2) {
  const b = Buffer.alloc(33); b.set([137,80,78,71,13,10,26,10]); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(3, 20); return b.toString('base64');
}
for (const ceiling of [true, false]) test(`MCP publications enforce approval and policy during upload (ceiling=${ceiling})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publications-')), journal = AgentSendJournal.open(root), approvals = fixtureApprovals(journal, root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const policy = new SendPolicy({ ceiling: ceiling ? ['123456789'] : [], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  let sends = 0, pause = false, retained: readonly Uint8Array[] = [];
  const session = { selfUserId: '123456789', getState: () => ({ connected: true }), listChats: () => [{ id: '123456789', maxLogId: '9007199254740993' }],
    forwardMessage: async () => { sends++; return { status: 0, logId: '9007199254740994' }; },
    uploadMedia: async (_id: string, options: { data: Uint8Array }) => { sends++; retained = [options.data]; return { status: 0, chatLog: { logId: '9007199254740994' } }; },
    uploadMultiPhotos: async (_id: string, photos: readonly Uint8Array[], beforeStep: () => void) => {
      sends++; retained = photos; beforeStep();
      if (pause) { policy.setPaused(true); beforeStep(); }
      return { status: 0, logId: '9007199254740994' };
    } } as unknown as KakaoSession;
  const service = new AgentPublicationService({ principal: 'local-mcp', journal, policy, approvals: approvals.store, adapter: agentPublicationAdapter(session, policy) });
  const server = new McpStdioServer({ name: 'fixture', version: '1', toolGroups: ['chats'] }); registerAgentPublicationTools(server, () => service);
  const call = async (name: string, args: object) => {
    const input = new PassThrough(); let text = '';
    const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    const done = new Promise<void>(resolve => server.serveConnection(input, output, resolve));
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n'); await done;
    return JSON.parse(text).result;
  };
  for (const [tool, payload] of [
    ['send_photos', { dataBase64: png(), fileName: 'fixture.png' }],
    ['forward_message', { text: 'fixture forward', type: 1 }],
    ['send_photos', { photos: [png(), png(3)] }]
  ] as const) {
    const args = { ...payload, chatId: '123456789', requestId: randomUUID() };
    const initial = sends;
    const asked = await call(tool, args);
    assert.equal(asked.structuredContent.error.code, 'APPROVAL_REQUIRED'); assert.equal(sends, initial);
    assert.equal((await call(tool, { ...args, confirm: true })).structuredContent.error.code, 'INVALID_ARGUMENT');
    approvals.approve(asked.structuredContent.error.details.approval);
    assert.equal(JSON.parse((await call(tool, args)).content[0].text).logId, '9007199254740994');
    assert.equal((await call(tool, args)).isError, false); assert.equal(sends, initial + 1);
    assert.ok(retained.every(b => b.every(v => v === 0)));
  }
  // Daemon file paths are not an input, and exactly one of dataBase64 or photos is required.
  for (const bad of [{ filePath: '/private/operator.pem', fileName: 'fixture.png', dataBase64: png() }, { photoPath: '/private/operator.pem' },
    { dataBase64: png(), fileName: 'fixture.png', photos: [png(), png(3)] }, { photos: [png(), png(3)], fileName: 'ignored.png' },
    { photos: [png(), png(3)], type: 18 }, {}]) {
    assert.equal((await call('send_photos', { ...bad, requestId: randomUUID(), chatId: '123456789' })).structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(sends, 3);
  // Policy cancellation between bundle items is conservative once any upload may have occurred.
  pause = true;
  const args = { requestId: randomUUID(), chatId: '123456789', photos: [png(), png(3)] };
  approvals.approve((await call('send_photos', args)).structuredContent.error.details.approval);
  const result = await call('send_photos', args);
  assert.equal(result.structuredContent.error.code, 'SEND_OUTCOME_UNKNOWN'); assert.equal(result.structuredContent.error.retryable, false);
  assert.ok(retained.every(b => b.every(value => value === 0)));
  assert.equal((await call('send_photos', args)).structuredContent.error.code, 'SEND_OUTCOME_UNKNOWN'); assert.equal(sends, 4);
});
