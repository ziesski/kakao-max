// Fixture-only MCP server to try the client confirmation dialog (MCP 2026-07-28 MRTR elicitation)
// against a real Claude Code session. No KakaoTalk account, daemon, credentials or network:
// a temporary journal and a fake adapter that only records what would have been sent.
// Every request/response is summarized (no message text) in ./fixture.log next to this file (gitignored).
// Dev tool only: never point this at a real account; it has no daemon, credentials or network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AgentSendJournal, AgentSendService, ApprovalStore, ApproverRegistry, RecipientPermissions, SendPolicy } from '../../packages/core/src/index.ts';
import { McpStdioServer } from '../../apps/mcp/src/mcp-stdio.ts';
import { ElicitationApprovals } from '../../apps/mcp/src/client-approval.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(here, 'fixture.log');
const log = (entry: Record<string, unknown>) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const CHAT = '123456789'; // fixture room ID, not a real room

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-elicitation-fixture-'));
const journal = AgentSendJournal.open(root);
const store = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
// Assistant profile: a room allowed once in the dialog takes later sends without asking (daily cap 50).
const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'Asia/Seoul' });
const service = new AgentSendService({ principal: 'local-mcp', journal, approvals: store, standing: recipients, approvalWindow: () => 15 * 60_000,
  policy: new SendPolicy({ allowlist: [CHAT], pausedAtStart: false, auditLogPath: path.join(root, 'audit') }),
  adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture',
    send: async message => { log({ event: 'FAKE_SEND (nothing left this machine)', chatId: message.chatId, textLength: message.text.length }); return { status: 0, logId: String(Date.now()) }; } } });

const server = new McpStdioServer({ name: 'kakao-elicitation-fixture', version: '0.0.1',
  instructions: 'Fixture for testing approval dialogs. Call prepare_message with a fresh UUID requestId, chatId "123456789" and the text, then call send_message with the same requestId, chatId and text. Do not try to approve anything yourself.' });
server.setClientApproval(new ElicitationApprovals(store, Date.now, recipients));
const fields = { requestId: { type: 'string', description: 'A fresh UUID; reuse it for send_message.' }, chatId: { type: 'string', description: 'Use "123456789".' }, text: { type: 'string' } };
server.registerTool({ name: 'prepare_message', description: 'Prepare a fixture message without sending it.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: fields, required: ['requestId', 'chatId', 'text'], additionalProperties: false },
  handler: a => { const p = service.prepare(a.requestId, { chatId: a.chatId, text: a.text }); return { requestId: p.requestId, state: p.state, approvalRequired: p.approvalRequired, expiresAt: p.expiresAt }; } });
server.registerTool({ name: 'send_message', description: 'Send a prepared fixture message. If approval is needed your client shows a dialog to the person.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: fields, required: ['requestId', 'chatId', 'text'], additionalProperties: false },
  handler: a => service.send(a.requestId, { chatId: a.chatId, text: a.text }) });

// Tee the wire into a content-free log so the session can be inspected afterwards.
const input = new PassThrough();
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    try {
      const m = JSON.parse(line), meta = m.params?._meta ?? {};
      log({ dir: 'in', method: m.method ?? '(response)', id: m.id, protocolVersion: meta['io.modelcontextprotocol/protocolVersion'] ?? m.params?.protocolVersion,
        client: meta['io.modelcontextprotocol/clientInfo'] ?? m.params?.clientInfo, capabilities: meta['io.modelcontextprotocol/clientCapabilities'] ?? m.params?.capabilities,
        tool: m.params?.name, hasRequestState: m.params?.requestState !== undefined, inputResponses: m.params?.inputResponses });
    } catch { log({ dir: 'in', parseError: true }); }
  }
  input.write(chunk);
});
process.stdin.on('end', () => input.end());
const output = new Writable({ write(chunk, _enc, done) {
  for (const line of chunk.toString().split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); log({ dir: 'out', id: r.id, resultType: r.result?.resultType, isError: r.result?.isError, error: r.error?.code ?? r.result?.structuredContent?.error?.code, askedDialog: !!r.result?.inputRequests }); }
    catch { log({ dir: 'out', unparsed: true }); }
  }
  process.stdout.write(chunk, done);
} });
server.serveConnection(input, output, () => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
log({ event: 'fixture started', pid: process.pid });
