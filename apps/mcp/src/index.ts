#!/usr/bin/env node
// ----------------------------------------------------------------------------
// kakao-max MCP server: assembles the tools over one live KakaoTalk session.
//
// Transport: stdio (newline-delimited JSON-RPC 2.0), or a local socket when KAKAO_MCP_LISTEN is set.
//   { "command": "node", "args": ["--experimental-strip-types", "apps/mcp/src/index.ts"] }
// Tools live in ./tools; core tools are always listed, optional groups via KAKAO_MCP_TOOL_GROUPS.
// ----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { McpStdioServer } from './mcp-stdio.ts';
import { KakaoSession, SendPolicy, AgentSendService, AgentPublicationService, AgentMutationService, AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AgentSendJournal, ApprovalStore, ApproverRegistry, RecipientPermissions, DailyActionLimit, approvalWindowFromConfig, loadConfig, loadPolicyConfig, KakaoError, toKakaoError, agentModeApproves, MCP_TOOL_GROUPS } from '@kakao-max/core';
import { serveSocket, parseListenSpec, validateListenSpec } from './socket-transport.ts';
import { allowedUids } from './peer-user.ts';
import { registerMessageInboxTools } from './tools/message-inbox.ts';
import { registerAgentMessageTools, agentMessageAdapter } from './tools/agent-messages.ts';
import { registerChatDiscoveryTools } from './tools/chat-discovery.ts';
import { registerChatTools } from './tools/chats.ts';
import { registerFriendsTools } from './tools/friends.ts';
import { registerAgentPublicationTools, agentPublicationAdapter } from './tools/agent-publications.ts';
import { registerAgentMutationTools, agentMutationAdapter } from './tools/agent-mutations.ts';
import { registerCoreReadTools } from './tools/core-read.ts';
import { ApprovalCenter, setApprovalCenter } from './approval-center.ts';
import { ElicitationApprovals } from './client-approval.ts';
import { createApprovalServer } from './approval-server.ts';
import { registerPermissionTools, registerNamedOperationTools, agentControlAdapter, grantViews, type GrantViews } from './tools/agent-operations.ts';
import { loadOptionalModules, registerOptionalModules, checkToolGroups } from './optional-modules.ts';
import { registerVaultTools } from './tools/vault.ts';
import { serverInstructions } from './instructions.ts';

const kakao = new KakaoSession();
const groups = kakao.config.mcpToolGroups;
// Optional modules are loaded only when their package is installed.
const optionalModules = await loadOptionalModules(kakao);
checkToolGroups(groups, MCP_TOOL_GROUPS, optionalModules);
const server = new McpStdioServer({ name: 'kakao-max', version: '0.1.0', instructions: serverInstructions(kakao.config.agentMode), toolGroups: groups });
const policy = new SendPolicy(loadPolicyConfig());
let agentSendService: AgentSendService | undefined;
let agentPublicationService: AgentPublicationService | undefined;
let agentMutationService: AgentMutationService | undefined;
let agentOperationEngine: AgentOperationEngine | undefined;
let approvalCenter: ApprovalCenter | undefined;
let grants: GrantViews | undefined;
let approvalServer: ReturnType<typeof createApprovalServer> | undefined;
let agentJournal: AgentSendJournal | undefined;
let friendAddLimit: DailyActionLimit | undefined;

/** Services exist once main() opened the journal; tools registered before that fail closed until then. */
function ready<T>(value: T | undefined, what: string): T {
  if (!value) throw new KakaoError('NOT_CONNECTED', `${what} is not ready`);
  return value;
}
const operationEngine = () => ready(agentOperationEngine, 'Agent operation engine');

registerCoreReadTools(server, { kakao, policy, config: kakao.config, groups, grants: () => grants, engine: operationEngine, friendAdds: () => friendAddLimit });
registerChatDiscoveryTools(server, kakao);
registerAgentMessageTools(server, () => ready(agentSendService, 'Agent message service'));
registerAgentPublicationTools(server, () => ready(agentPublicationService, 'Agent publication service'));
registerAgentMutationTools(server, () => ready(agentMutationService, 'Agent mutation service'));
registerPermissionTools(server, { engine: operationEngine, grants: () => ready(grants, 'Permissions'), policy });
registerNamedOperationTools(server, operationEngine);
registerChatTools(server, kakao);
registerFriendsTools(server, kakao);
registerOptionalModules(server, optionalModules, operationEngine);
registerMessageInboxTools(server, kakao);
registerVaultTools(server, kakao);

let socketServer: ReturnType<typeof serveSocket> | undefined;

async function main() {
  // Reject unsafe transport configuration before opening the sole live session.
  const listen = loadConfig().mcpListen;
  const spec = listen ? parseListenSpec(listen) : undefined;
  if (spec) validateListenSpec(spec);
  agentJournal = AgentSendJournal.open(kakao.config.dataDir);
  const registry = new ApproverRegistry(kakao.config.dataDir);
  const approvals = new ApprovalStore(agentJournal, registry, Date.now, { clientConfirmations: kakao.config.approval.clientConfirm });
  const approvalWindow = approvalWindowFromConfig(kakao.config.approval);
  // A room the person allowed once takes later messages/photos without per-message approval.
  // In trust mode every room is allowed (ceiling, pause and rate limits still apply) and account changes need no approval.
  // The account's own memo chat is allowed in every mode.
  const isMemoChat = (chatId: string) => kakao.isMemoChat(chatId);
  const recipients = new RecipientPermissions(agentJournal, { dailyLimit: kakao.config.recipientDailyLimit, timeZone: kakao.config.client.timeZone,
    allRooms: kakao.config.agentMode === 'trust', isMemoChat });
  // Leaving a room (here, on another device, or found at login) ends its send permission too.
  kakao.onChatLeft(chatId => { if (recipients.revoke(chatId)) process.stderr.write('[mcp] left room: send permission withdrawn\n'); });
  const modeApproves = (action: string) => agentModeApproves(kakao.config.agentMode, action);
  const friendAdds = new DailyActionLimit(agentJournal.db, { action: 'add_friend', limit: kakao.config.addFriendDailyLimit, timeZone: kakao.config.client.timeZone });
  friendAddLimit = friendAdds;
  grants = grantViews(kakao, recipients);
  // Modern (2026-07-28) clients that support form elicitation can ask the person directly.
  // A one-time read dialog may also open the room for later reads, like "don't ask again" for sends.
  const roomReads = { allowRead: (chatId: string) => { kakao.setRoomAccess(chatId, { mode: 'immediate' }); } };
  server.setClientApproval(kakao.config.approval.clientConfirm ? new ElicitationApprovals(approvals, Date.now, recipients, roomReads) : undefined);
  registry.list(); // fail fast on an unsafe or corrupt registry, before the account session opens
  agentSendService = new AgentSendService({ principal: 'local-mcp', journal: agentJournal, adapter: agentMessageAdapter(kakao), policy, approvals, approvalWindow, recipients, modeApproves });
  agentPublicationService = new AgentPublicationService({ principal: 'local-mcp', journal: agentJournal, adapter: agentPublicationAdapter(kakao, policy), policy, approvals, approvalWindow, recipients: recipients, modeApproves });
  agentMutationService = new AgentMutationService({ principal: 'local-mcp', journal: agentJournal, adapter: agentMutationAdapter(kakao), policy, approvals, approvalWindow, modeApproves, isMemoChat });
  agentOperationEngine = new AgentOperationEngine({ principal: 'local-mcp', journal: agentJournal, adapter: agentControlAdapter(kakao, policy, recipients, friendAdds, optionalModules.map(m => ({ actions: m.operations.map(d => d.action), inspect: m.inspect }))),
    definitions: [...AGENT_CONTROL_DEFINITIONS, ...optionalModules.flatMap(m => m.operations)], approvals, approvalWindow, rateLimit: () => policy.describe().rateLimit, modeApproves });
  const approval = kakao.config.approval;
  if (approval.listen && approval.origin) {
    const notifyChatId = policy.describe().notifyChatId;
    // Content-free approval link to the notice destination, through the journaled send path. Only this
    // daemon-owned notifier may skip approval there; agents need a room permission like any other room.
    const notifier = new AgentSendService({ principal: 'local-notify', journal: agentJournal, adapter: agentMessageAdapter(kakao), policy, approvals, approvalWindow, notifications: true });
    const notify = approval.notify && notifyChatId ? async (text: string) => {
      const id = randomUUID(), message = { chatId: notifyChatId, text };
      const prepared = notifier.prepare(id, message);
      if (prepared.approvalRequired) throw new KakaoError('POLICY_DENIED', 'Notice destination is not available');
      await notifier.send(id, message);
    } : undefined;
    approvalCenter = new ApprovalCenter({ store: approvals, origin: approval.origin, notify, recipients });
    setApprovalCenter(approvalCenter, approvals);
    const [host, port] = [approval.listen.slice(0, approval.listen.lastIndexOf(':')).replace(/^\[|\]$/g, ''), Number(approval.listen.slice(approval.listen.lastIndexOf(':') + 1))];
    approvalServer = createApprovalServer({ center: approvalCenter, registry, origin: approval.origin, dataDir: kakao.config.dataDir, listen: approval.listen,
      log: l => process.stderr.write(l + '\n') });
    approvalServer.listen(port, host, () => process.stderr.write('[mcp] passkey approval page listening\n'));
  } else setApprovalCenter(undefined, approvals);
  process.stderr.write('[mcp] connecting live KakaoTalk session...\n');
  await kakao.start();

  // Always-on daemon mode: when KAKAO_MCP_LISTEN is set we hold the warm LOCO session
  // and serve MCP over a socket (the personal-agent runtime / Claude Code connect over
  // the tailnet). Otherwise fall back to the classic one-client stdio transport.
  if (spec) {
    process.stderr.write('[mcp] session connected; starting MCP socket server\n');
    // Other OS users on this host could answer the client dialog themselves; serve only allowed ones (Linux).
    const allowed = !spec.path && process.platform === 'linux' ? allowedUids(kakao.config.mcpAllowedUids, process.getuid!()) : undefined;
    if (!spec.path && !allowed) process.stderr.write(`[mcp] WARN: no OS user check on ${process.platform}: every local user and program can use this account through ${spec.host}:${spec.port}. Run only on a single-user computer${process.platform === 'darwin' ? ', or listen on a Unix socket in an owner-only directory' : ''}.\n`);
    else if (allowed) process.stderr.write(`[mcp] MCP TCP serves OS users ${[...allowed].join(',')}\n`);
    socketServer = serveSocket(server, spec, { allowedUids: allowed,
      log: (l) => process.stderr.write(`[mcp] ${l}\n`),
      onConnection: () => process.stderr.write('[mcp] client connected\n')
    });
  } else {
    process.stderr.write('[mcp] session connected; starting MCP stdio server\n');
    server.listen();
  }
}

function shutdown(): void {
  socketServer?.close();
  approvalServer?.close();
  approvalCenter?.close();
  kakao.stop();
  agentJournal?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  process.stderr.write(`[mcp] fatal: ${toKakaoError(e).code}\n`);
  process.exit(1);
});
