import { prepareAndCommit, REQUEST_ID } from './one-call.ts';
import { canonicalAgentJson, KakaoError, toKakaoError, type KakaoSession, type AgentMutationAdapter, type AgentMutationService, type AgentMutationAction, type AgentMutationRequest } from '@kakao-max/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

/** A read refusal while inspecting the target says what the agent can do next instead of a bare denial. */
function readHint(e: unknown, mode: string, confirmed: boolean): unknown {
  const err = toKakaoError(e);
  if (err.code !== 'POLICY_DENIED') return err;
  if (mode === 'manual' && !confirmed) return new KakaoError('POLICY_DENIED', `${err.message}. For a message in a manual room, call again with confirmRead=true; the person's approval of this change then covers reading that one stored message`);
  if (mode === 'deny') return new KakaoError('POLICY_DENIED', `${err.message}. This room is closed to reading, so its stored message cannot be checked. The person can open it ("always for this room" in the read_messages dialog, or request_permission room_access); then try again`);
  return err;
}

export function agentMutationAdapter(kakao: KakaoSession): AgentMutationAdapter {
  const room = (id: string) => {
    const found = kakao.listChats().find(c => c.id === id);
    if (!found) throw new KakaoError('NOT_FOUND','Exact mutation room unavailable');
    return { maxLogId:found.maxLogId,memberCount:found.memberCount ?? null };
  };
  return {accountId:()=>kakao.selfUserId,connected:()=>kakao.getState().connected,
    inspect: async (action, request) => {
      if (action === 'update_my_profile') {
        const current = await kakao.getMyProfile(request.profileId);
        if (current.profile.profileId !== request.profileId || !current.profiles.some(p => p.profileId === request.profileId)) throw new KakaoError('NOT_FOUND','Exact profile target unavailable');
        return {context:{kind:'profile',target:{profileId:current.profile.profileId,nickname:current.profile.nickname ?? null,statusMessage:current.profile.statusMessage ?? null}},
          validate:()=>{if(!kakao.getState().connected)throw new KakaoError('NOT_CONNECTED','Account disconnected');},
          execute:async()=>{ const out=await kakao.updateMyProfile(request.profileId!,{statusMessage:request.statusMessage}); return {status:out.status}; }};
      }
      const sourceChat=action==='send_emoticon'?request.fromChatId!:request.chatId!;
      const destination=room(request.chatId!), source=await kakao.inspectAgentStoredMessage(sourceChat,action==='send_emoticon'?request.fromLogId!:request.logId!,{confirmRead:request.confirmRead})
        .catch(e => { throw readHint(e, kakao.getRoomAccess(sourceChat).rule.mode, request.confirmRead === true); });
      if (action === 'send_emoticon' && !source.emoticonSupported) throw new KakaoError('INVALID_ARGUMENT','Stored source is not a supported emoticon');
      const sourceRoom=action==='send_emoticon'?room(request.fromChatId!):undefined;
      return {context:{kind:'message',target:source.target,room:destination,...(sourceRoom?{sourceRoom}:{})},
        validate:()=>{source.validate();if(canonicalAgentJson(room(request.chatId!))!==canonicalAgentJson(destination) || sourceRoom && canonicalAgentJson(room(request.fromChatId!))!==canonicalAgentJson(sourceRoom))throw new KakaoError('OPERATION_STALE','Locally known mutation room changed');},
        execute:async()=>{
          if(action==='send_emoticon')return source.sendEmoticonTo(request.chatId!);
          const out=action==='edit_message'?await source.edit(request.text!):await source.delete();
          return {status:out.status};
        }};
    }};
}
const NOTE = 'Always needs the person\'s approval, in every room. Binds the exact account, target, payload, current stored or fetched context and policy. ' +
  'Inspecting a source or target message needs its room read permission and a fresh unread count of 0; only your own stored messages can be edited or deleted. ' +
  'Durable claim precedes the external action. MUTATION_OUTCOME_UNKNOWN requires manual resolution; never repeat or replace the requestId. ' +
  'applied_unverified is a provider acknowledgement, not readback.';
const confirmRead = { type: 'boolean', description: 'Manual read approval only; deny/unread restrictions still apply.' };

function run(service: () => AgentMutationService, action: AgentMutationAction, requestId: string, request: Record<string, unknown>) {
  const r = request as AgentMutationRequest;
  return prepareAndCommit({ prepare: () => service().prepare(action, requestId, r), commit: () => service().commit(action, requestId, r) })
    .then(out => markUntrusted({ ...out }));
}
function pick(args: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

export function registerAgentMutationTools(server: McpStdioServer, service: () => AgentMutationService): void {
  server.registerTool({
    name: 'edit_or_delete_message',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Edit (action "edit", with text) or delete for everyone (action "delete") one of your own messages. ' + NOTE + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: { requestId: REQUEST_ID, action: { type: 'string', enum: ['edit', 'delete'] },
      chatId: { type: 'string' }, logId: { type: 'string' }, text: { type: 'string', description: 'Required for edit.' }, confirmRead },
      required: ['requestId', 'action', 'chatId', 'logId'], additionalProperties: false },
    handler: args => {
      if (args.action === 'edit' && typeof args.text !== 'string') throw new KakaoError('INVALID_ARGUMENT', '"text" is required to edit');
      if (args.action === 'delete' && args.text !== undefined) throw new KakaoError('INVALID_ARGUMENT', '"text" is only for edit');
      return run(service, args.action === 'edit' ? 'edit_message' : 'delete_message', args.requestId, pick(args, ['chatId', 'logId', 'text', 'confirmRead']));
    }
  });
  server.registerTool({
    name: 'send_emoticon',
    group: 'chats',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Send the emoticon from one stored message (fromChatId/fromLogId) to one exact room. ' + NOTE + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: { requestId: REQUEST_ID, chatId: { type: 'string' }, fromChatId: { type: 'string' }, fromLogId: { type: 'string' }, confirmRead },
      required: ['requestId', 'chatId', 'fromChatId', 'fromLogId'], additionalProperties: false },
    handler: args => run(service, 'send_emoticon', args.requestId, pick(args, ['chatId', 'fromChatId', 'fromLogId', 'confirmRead']))
  });
  server.registerTool({
    name: 'update_my_profile',
    group: 'friends',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Change the status message of one exact profile (every friend sees it). Profile snapshots have no server-side compare-and-swap guarantee. ' + NOTE,
    inputSchema: { type: 'object', properties: { requestId: REQUEST_ID,
      profileId: { type: 'string', description: 'Exact explicit profile ID; no implicit main-profile fallback.' },
      statusMessage: { type: 'string', description: 'Exact status message, at most 90 UTF-8 bytes. Empty clears it.' } },
      required: ['requestId', 'profileId', 'statusMessage'], additionalProperties: false },
    handler: args => run(service, 'update_my_profile', args.requestId, pick(args, ['profileId', 'statusMessage']))
  });
}
