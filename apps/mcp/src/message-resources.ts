import { KakaoError, type KakaoSession, type SendPolicy } from '@kakao-max/core';
import type { McpStdioServer } from './mcp-stdio.ts';

const TEMPLATE = 'kakao://rooms/{chatId}/messages';
function room(uri: string): string {
  const match = /^kakao:\/\/rooms\/([1-9]\d{0,18})\/messages$/.exec(uri);
  if (!match || BigInt(match[1]) > 9223372036854775807n) throw new KakaoError('INVALID_ARGUMENT', 'Invalid room message resource');
  return match[1];
}

/** Content-free change signals. Message delivery stays on read_messages and its budgets. */
export function registerMessageResources(server: McpStdioServer, kakao: Pick<KakaoSession, 'authorizeMessageWatch' | 'watchRoomMessages'>,
  policy: Pick<SendPolicy, 'isPaused' | 'withinCeiling' | 'onPauseChanged'>): void {
  const allowed = (chatId: string) => {
    if (policy.isPaused() || !policy.withinCeiling(chatId)) throw new KakaoError('POLICY_DENIED', 'Room updates are paused or outside the operator ceiling');
  };
  server.setResourceSubscriptions({
    templates: [{ uriTemplate: TEMPLATE, name: 'Room message updates', description: 'Content-free change signals for one authorized room. Read contents through read_messages.', mimeType: 'application/json' }],
    async read(uri) { const chatId = room(uri); allowed(chatId); await kakao.authorizeMessageWatch(chatId); return { untrusted: true, kind: 'room-message-updates' }; },
    async subscribe(uri, notify) {
      const chatId = room(uri); allowed(chatId);
      let closed = false;
      let unpause = () => {};
      const unwatch = await kakao.watchRoomMessages(chatId, code => {
        if (closed) return;
        try { allowed(chatId); } catch { code = 'POLICY_DENIED'; }
        if (code) { closed = true; unpause(); }
        notify(code);
      });
      const stop = () => { closed = true; unwatch(); unpause(); };
      // Recheck after the async subscription authorization (pause may have changed).
      try { allowed(chatId); } catch (e) { stop(); throw e; }
      unpause = policy.onPauseChanged(() => { if (policy.isPaused() && !closed) { stop(); notify('POLICY_DENIED'); } });
      return stop;
    }
  });
}
