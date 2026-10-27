import { prepareAndCommit, REQUEST_ID } from './one-call.ts';
import { KakaoError, type KakaoSession, type SendPolicy, type AgentPublicationAdapter, type AgentPublicationService,
  type AgentPublicationAction, type AgentPublicationInput } from '@kakao-max/core';
import { agentMessageAdapter } from './agent-messages.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function agentPublicationAdapter(kakao: KakaoSession, policy: SendPolicy): AgentPublicationAdapter {
  const metadata = agentMessageAdapter(kakao);
  return { accountId: metadata.accountId, connected: metadata.connected, context: metadata.context,
    send: async (action, { descriptor: m, buffers }) => {
      if (action === 'forward_message') return kakao.forwardMessage(m.chatId, { text: m.text!, type: m.type!, extra: m.extra });
      if (action === 'send_photo_bundle') return kakao.uploadMultiPhotos(m.chatId, buffers, () => {
        // One durable claim covers the bundle; recheck pause/ceiling without consuming more rate slots.
        const p = policy.describe();
        if (policy.isPaused() || p.notifyChatId !== m.chatId && !policy.withinCeiling(m.chatId)) {
          throw new KakaoError('POLICY_DENIED', 'Publication policy changed during bundle upload');
        }
      });
      const res = await kakao.uploadMedia(m.chatId, { data: buffers[0], type: m.type!, fileName: m.fileName,
        width: m.width, height: m.height, ext: m.ext });
      return { status: res.status, logId: res.chatLog.logId };
    }
  };
}
const LARGE = 24 * 1024 * 1024;
const OUTCOME = 'Durable claim precedes any upload or forward. SEND_OUTCOME_UNKNOWN requires manual resolution, never an automatic resend or new requestId. ' +
  'sent_unverified is a server acknowledgement, not delivery proof. No history or read receipt is requested.';

export function registerAgentPublicationTools(server: McpStdioServer, service: () => AgentPublicationService): void {
  server.registerTool({
    name: 'send_photos',
    maxRequestBytes: LARGE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Send one photo or file (dataBase64 + fileName) or an ordered photo bundle (photos) to one exact room. Bytes are passed inline; ' +
      'daemon file paths are not accepted, so a prompt cannot make the daemon read and send its own files. One call: in a room the person already allowed ' +
      'it sends at once; otherwise the person approves on the passkey page, which previews the exact images (a text dialog cannot show them). ' + OUTCOME,
    inputSchema: { type: 'object', properties: {
      requestId: REQUEST_ID, chatId: { type: 'string', description: 'Exact canonical room ID.' },
      dataBase64: { type: 'string', description: 'One photo or file, canonical base64, at most 16 MiB decoded.' },
      fileName: { type: 'string', description: 'Required with dataBase64.' },
      type: { type: 'number', description: 'With dataBase64: photo=2 (default), video=3, audio=5, file=18.' },
      width: { type: 'number' }, height: { type: 'number' },
      photos: { type: 'array', items: { type: 'string' }, description: 'Ordered 2–30 JPEG/PNG base64 photos, at most 16 MiB total.' }
    }, required: ['requestId', 'chatId'], additionalProperties: false },
    handler: args => {
      const bundle = args.photos !== undefined;
      if (bundle === (args.dataBase64 !== undefined)) throw new KakaoError('INVALID_ARGUMENT', 'Provide exactly one of dataBase64 (with fileName) or photos');
      if (bundle && ['fileName', 'type', 'width', 'height'].some(key => args[key] !== undefined))
        throw new KakaoError('INVALID_ARGUMENT', 'fileName, type, width and height apply only to a single dataBase64 publication');
      const action: AgentPublicationAction = bundle ? 'send_photo_bundle' : 'send_media';
      const payload: Record<string, unknown> & { chatId: string } = { chatId: args.chatId };
      for (const key of bundle ? ['photos'] : ['dataBase64', 'fileName', 'type', 'width', 'height']) if (args[key] !== undefined) payload[key] = args[key];
      const input: AgentPublicationInput = { ...payload, chatId: args.chatId };
      return prepareAndCommit({ prepare: () => service().prepare(action, args.requestId, input), commit: () => service().send(action, args.requestId, input),
        media: () => bundle ? (args.photos as string[]).map(p => Buffer.from(p, 'base64'))
          : (args.type ?? 2) === 2 ? [Buffer.from(String(args.dataBase64), 'base64')] : [] });
    }
  });
  server.registerTool({
    name: 'forward_message',
    group: 'chats',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Forward exact message text with its bounded attachment JSON to one exact room. Always needs the person\'s approval, even in an allowed room. ' + OUTCOME,
    inputSchema: { type: 'object', properties: {
      requestId: REQUEST_ID, chatId: { type: 'string' }, text: { type: 'string' }, type: { type: 'number' },
      extra: { type: 'string', description: 'Exact bounded attachment JSON string; not proof of attachment provenance.' }
    }, required: ['requestId', 'chatId', 'text'], additionalProperties: false },
    handler: args => {
      const payload: Record<string, unknown> = { chatId: args.chatId, text: args.text };
      for (const key of ['type', 'extra']) if (args[key] !== undefined) payload[key] = args[key];
      const input: AgentPublicationInput = { ...payload, chatId: args.chatId };
      return prepareAndCommit({ prepare: () => service().prepare('forward_message', args.requestId, input), commit: () => service().send('forward_message', args.requestId, input) });
    }
  });
}
