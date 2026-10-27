import { prepareAndCommit, REQUEST_ID } from './one-call.ts';
import { canonicalAgentJson, KakaoError, type KakaoSession, type AgentMessage, type AgentSendAdapter, type AgentSendService } from '@kakao-max/core';
import type { McpStdioServer } from '../mcp-stdio.ts';

/** Platform adapter: existing session only, with no content read or read-receipt call. */
export function agentMessageAdapter(kakao: Pick<KakaoSession, 'selfUserId' | 'getState' | 'listChats' | 'sendMessage' | 'sendReply' | 'sendWithMentions'>): AgentSendAdapter {
  return {
    accountId: () => kakao.selfUserId,
    connected: () => kakao.getState().connected,
    context: chatId => {
      const chat = kakao.listChats().find(c => c.id === chatId);
      if (!chat) throw new KakaoError('NOT_FOUND', 'Exact account room unavailable');
      return canonicalAgentJson({ maxLogId: chat.maxLogId, memberCount: chat.memberCount ?? null });
    },
    send: async message => {
      const result = message.mentions?.length ? await kakao.sendWithMentions(message.chatId, message.text, message.mentions)
        : message.replyToLogId ? await kakao.sendReply(message.chatId, message.text, {
          logId: message.replyToLogId, userId: message.replyToUserId!, message: message.replyToText })
        : await kakao.sendMessage(message.chatId, message.text);
      return { status: result.status, logId: result.logId };
    }
  };
}
const fields = {
  requestId: REQUEST_ID,
  chatId: { type: 'string', description: 'Exact canonical room ID.' }, text: { type: 'string', description: 'Exact text; whitespace and Unicode are significant.' },
  replyToLogId: { type: 'string' }, replyToUserId: { type: 'string' }, replyToText: { type: 'string' },
  mentions: { type: 'array', items: { type: 'object', properties: {
    userId: { type: 'string' }, at: { type: 'array', items: { type: 'number' } }, len: { type: 'number' }
  }, required: ['userId','at','len'], additionalProperties: false } }
};
function payload(args: Record<string, any>): AgentMessage {
  const message: Record<string, unknown> = {};
  for (const key of ['chatId','text','replyToLogId','replyToUserId','replyToText','mentions']) if (args[key] !== undefined) message[key] = args[key];
  return { ...message, chatId: args.chatId, text: args.text } as AgentMessage;
}
export function registerAgentMessageTools(server: McpStdioServer, service: () => AgentSendService): void {
  server.registerTool({
    name: 'send_message',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Send text (optionally a reply or mentions) to one exact room as the account owner. One call: in a room the person already allowed it sends at once; ' +
      'otherwise the person approves in the client dialog (or on the passkey page) and the person may allow that room for later messages and photos. ' +
      'Room scope, pause and rate limits are rechecked and the attempt is durably claimed before sending. Does not read room contents or send read receipts. ' +
      'sent_unverified is a server acknowledgement, not delivery proof. SEND_OUTCOME_UNKNOWN is never retryable: inspect Kakao manually and never replace the requestId.',
    inputSchema: { type: 'object', properties: fields, required: ['requestId','chatId','text'], additionalProperties: false },
    handler: args => {
      const message = payload(args);
      return prepareAndCommit({ prepare: () => service().prepare(args.requestId, message), commit: () => service().send(args.requestId, message) });
    }
  });
}
