import { readGrant } from '../read-grant.ts';
import type { KakaoSession } from '@kakao-max/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function registerMessageInboxTools(server: McpStdioServer, kakao: Pick<KakaoSession, 'claimMessageEvents' | 'ackMessageEvents'>): void {
  const room = { chatId: { type: 'string', description: 'Exactly one authorized room.' },
    consumer: { type: 'string', description: 'Stable local worker identity (competing consumers, not authenticated remote principals).' },
    readGrantId: { type: 'string', description: 'Manual rooms only: ID from a human-approved read_room operation covering this tool. Never bypasses deny or schedule restrictions.' } };
  server.registerTool({
    name: 'claim_message_events',
    group: 'events',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Claim durable locally received message events, scoped to one authorized room. No server message history is fetched and no read receipt is sent. ' +
      'Returns stable eventId/sourceGeneration plus unique leaseId and expiry per event. Process idempotently and durably before ack_message_events. ' +
      'A crash or lost response leaves events available after lease expiry; hasMore describes currently claimable work in this room only. ' +
      'Loop over bounded claims while hasMore; do not wait for another source write. Events predate this queue only when subsequently observed live. ' +
      'Content comes from the current stored message, not an immutable revision snapshot. Hidden/deleted messages are excluded before limit. ' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: { ...room, limit: { type: 'number', description: 'Default room bound, at most100 and subject to read budget.' },
      leaseMs: { type: 'number', description: '1000–300000; default60000. Expiry permits redelivery.' } }, required: ['chatId','consumer'], additionalProperties: false },
    handler: async args => markUntrusted(await kakao.claimMessageEvents(args.chatId, args.consumer,
      { limit: args.limit, leaseMs: args.leaseMs, ...readGrant(args, 'claim_message_events') }))
  });
  server.registerTool({
    name: 'ack_message_events',
    group: 'events',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Acknowledge only after downstream durable processing. Requires matching source generation, room, consumer and unexpired event leases. ' +
      'Repeated acknowledgement of the same lease is idempotent. Changed/expired leases conflict; no partial acknowledgement for a rejected batch. ' +
      'Room authorization and current unread restrictions are checked again, even if permission existed at claim time. No send or read receipt.',
    inputSchema: { type: 'object', properties: { ...room, sourceGeneration: { type: 'string' }, events: { type: 'array', items: { type: 'object',
      properties: { eventId: { type: 'string' }, leaseId: { type: 'string' } }, required: ['eventId','leaseId'], additionalProperties: false } } },
      required: ['chatId','consumer','sourceGeneration','events'], additionalProperties: false },
    handler: args => kakao.ackMessageEvents({ sourceGeneration: args.sourceGeneration, chatId: args.chatId, consumer: args.consumer,
      events: args.events, ...readGrant(args, 'ack_message_events') })
  });
}
