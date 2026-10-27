import fs from 'node:fs';
import { AGENT_MUTATION_ACTIONS, AGENT_CONTROL_ACTIONS, agentOperationDefinition, parseAgentMutationRequest, type AgentMutationAction, KakaoError, parseAgentMessage, normalizeAgentPublication, type AgentPublicationAction, isOwnerOnly } from '@kakao-max/core';
import { submitWrite, type AgentToolClient } from './agent-send-client.ts';

/** Explicit operator-supplied file; no draft is automatically persisted. */
export function readAgentRequest(file: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !isOwnerOnly(stat) || stat.size > 24 * 1024 * 1024) throw new Error('Unsafe request file');
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const { requestId, action = 'send_message', ...raw } = input;
    let message;
    if (action === 'send_message') message = parseAgentMessage(raw);
    else if (['send_media','send_photo_bundle','forward_message'].includes(action)) {
      const snapshot = normalizeAgentPublication(action as AgentPublicationAction, raw);
      snapshot.dispose(); message = raw;
    } else if (AGENT_MUTATION_ACTIONS.includes(action)) message = parseAgentMutationRequest(action as AgentMutationAction, raw);
    else if (AGENT_CONTROL_ACTIONS.includes(action)) message = agentOperationDefinition(action).parseRequest(raw);
    else throw new Error('Unsupported action');
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error('Invalid request');
    return { ...message, action: action as string, requestId };
  } catch (cause) { throw new KakaoError('INVALID_ARGUMENT', 'An owner-only bounded JSON request file is required', { cause }); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const PERMISSION_TYPES: Record<string, string> = { allow_recipient: 'send', read_room: 'read', grant_room_access: 'room_access', reset_room_access: 'room_default' };

/** The single-call tool and arguments for one request file. */
export function agentFileTool(input: ReturnType<typeof readAgentRequest>): { tool: string; args: { requestId: string; [key: string]: unknown }; kind: 'send' | 'mutation' | 'operation' } {
  const { action, requestId, ...payload } = input as { action: string; requestId: string; [key: string]: unknown };
  if (action === 'send_message') return { tool: 'send_message', args: { requestId, ...payload }, kind: 'send' };
  if (action === 'send_media' || action === 'send_photo_bundle') return { tool: 'send_photos', args: { requestId, ...payload }, kind: 'send' };
  if (action === 'forward_message') return { tool: 'forward_message', args: { requestId, ...payload }, kind: 'send' };
  if (action === 'edit_message' || action === 'delete_message') {
    return { tool: 'edit_or_delete_message', args: { requestId, action: action === 'edit_message' ? 'edit' : 'delete', ...payload }, kind: 'mutation' };
  }
  if (AGENT_MUTATION_ACTIONS.includes(action as AgentMutationAction)) return { tool: action, args: { requestId, ...payload }, kind: 'mutation' };
  if (PERMISSION_TYPES[action]) return { tool: 'request_permission', args: { requestId, type: PERMISSION_TYPES[action], ...payload }, kind: 'operation' };
  if (action === 'resume_sending') return { tool: 'pause', args: { requestId, paused: false }, kind: 'operation' };
  return { tool: action, args: { requestId, ...payload }, kind: 'operation' };
}

/** Run once to ask the person (prints the passkey link), and again with the same file after they approve. */
export async function runAgentFileCommand(client: AgentToolClient, file: string) {
  const { tool, args, kind } = agentFileTool(readAgentRequest(file));
  if (tool === 'pause') {
    const out = await client.callTool<{ paused: boolean }>('pause', args);
    if (out.paused) throw new KakaoError('APPROVAL_REQUIRED', 'Sending is still paused; approve the release and run this again');
    return out;
  }
  return submitWrite(client, tool, args, kind);
}
