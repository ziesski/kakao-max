// Public core surface used by the MCP and CLI adapters.
// Core owns the sole account session, stores, human approvals and shared write lifecycle.
export { KakaoSession } from './kakao-session.ts';
export type { LeftReason } from './kakao-session.ts';
export { SendPolicy, loadPolicyConfig, type PolicyDecision } from './policy.ts';
export { CredentialStore, writeEnvKeys } from './credentials.ts';
export { findEnvFile, readEnvFile } from './env-file.ts';
export { KakaoDb } from './db.ts';
export { MessageStore, type StoredMessage } from './message-store.ts';

export { longReplacer } from './long-json.ts';

export { KakaoError, toKakaoError } from './errors.ts';
export { isOwnerOnly, fsyncDir } from './private-fs.ts';
export { isMainModule, packagedEntry, installRoot, programArgs, setupCommand, PROGRAM_SOURCES, type ProgramName } from './entry.ts';

export { loadConfig, approvalWindowFromConfig, removedSettingsIn, parseAllowedUids, MCP_TOOL_GROUPS, type McpToolGroup, type KakaoConfig } from './config.ts';
export { AGENT_MODES, TRUST_APPROVED_ACTIONS, TRUST_RISK_NOTICE, agentModeApproves, type AgentMode } from './agent-mode.ts';

export { RoomAccessPolicy, READ_GRANT_TOOLS, registerReadGrantTool, isReadGrantTool, type ReadApproval, type ReadGrantTool } from './room-access.ts';

export { AgentSendService, AgentSendJournal, parseAgentMessage, canonicalAgentJson, clientMsgIdFor, SETTLE_GRACE_MS, type AgentMessage, type AgentSendAdapter, type SendAttempt } from './agent-send.ts';
export { RecipientPermissions, RECIPIENT_ACTIONS } from './recipient-permissions.ts';
export { DailyActionLimit } from './daily-action-limit.ts';

export { AgentPublicationService, normalizeAgentPublication, type AgentPublicationAction, type AgentPublicationInput, type AgentPublicationAdapter } from './agent-publication.ts';

export { AgentMutationService, AGENT_MUTATION_ACTIONS, parseAgentMutationRequest, type AgentMutationAction, type AgentMutationRequest, type AgentMutationAdapter } from './agent-mutation.ts';

export { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AGENT_CONTROL_ACTIONS, OPERATION_PARTS, agentOperationDefinition, type AgentOperationDefinition, type AgentOperationInspection, type AgentOperationEngineAdapter, type GrantRoomAccessRequest } from './agent-operation.ts';

export { ApprovalStore, ApproverRegistry, approvalChallenge, rpIdForOrigin, verifyWebAuthnRegistration, readOwnerOnlyJson, writeOwnerOnlyJson, type WebAuthnAssertion, type ApprovalEvent } from './approvals.ts';
export { LocalVault, type VaultStats, type ExportChatResult } from './local-vault.ts';
export { collectSharedLinks, extractScheduleAndTodos, type SharedLinkItem, type SharedLinksResult, type ExtractedScheduleItem, type ExtractedTodoItem, type ExtractedScheduleAndTodos } from './curation-tools.ts';
