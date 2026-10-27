import { createHash } from 'node:crypto';
import { KakaoError, type KakaoSession } from '@kakao-max/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function normalizeRoomName(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]+/gu, ''); }

type DiscoverySession = Pick<KakaoSession, 'listChats' | 'getChatInfo'>;
export async function findChatCandidates(kakao: DiscoverySession, args: { query?: string; participants?: string[]; memberCount?: number; cursor?: string; refresh?: boolean }) {
  const query = args.query ? normalizeRoomName(args.query) : undefined;
  const participants = args.participants?.map(p => normalizeRoomName(p)) ?? [];
  if ((!query && !participants.length && args.memberCount === undefined) || (args.query?.length ?? 0) > 200 ||
    participants.length > 10 || participants.some(p => !p) || (args.participants?.some(p => p.length > 100) ?? false) ||
    (args.memberCount !== undefined && (!Number.isInteger(args.memberCount) || args.memberCount < 1))) {
    throw new KakaoError('INVALID_ARGUMENT', 'Provide a room name, participant names, or a positive member count');
  }
  // A room whose member count is not known yet (e.g. found mid-session) is checked against its metadata below, not dropped.
  const chats = kakao.listChats().filter(c => args.memberCount === undefined || c.memberCount == null || c.memberCount === args.memberCount)
    .sort((a, b) => a.id.localeCompare(b.id));
  const binding = createHash('sha256').update(JSON.stringify([query, participants, args.memberCount, args.refresh === true, chats.map(c => c.id)])).digest('hex');
  let offset = 0;
  if (args.cursor) {
    try {
      if (args.cursor.length > 1024) throw new Error('length');
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= chats.length) throw new Error('scope');
      offset = cursor.offset;
    } catch { throw new KakaoError('CURSOR_CONFLICT', 'Room search or loaded rooms changed; restart find_chat without a cursor'); }
  }
  // A stable page makes every loaded room reachable, even while startup title
  // resolution is incomplete. Search cursors confer no content/send permission.
  const matches = [];
  let scanned = offset, inspected = 0;
  while (scanned < chats.length) {
    const chat = chats[scanned];
    // Explicit resolved titles can be checked locally. Unknown/member-fallback
    // titles still need bounded metadata hydration; never silently omit them.
    const explicit = chat.titleSource && chat.titleSource !== 'participants';
    if (query && !participants.length && !args.refresh && explicit && chat.title && !normalizeRoomName(chat.title).includes(query)) {
      scanned++; continue;
    }
    if (inspected >= 10) break;
    scanned++; inspected++;
    const meta = await kakao.getChatInfo(chat.id, args.refresh === true);
    const names = meta.members.map(m => normalizeRoomName(m.name));
    const titleMatched = !!query && normalizeRoomName(meta.title).includes(query);
    const participantsMatched = participants.length > 0 && participants.every(p => names.some(n => n.includes(p)));
    if (query && !titleMatched || participants.length > 0 && !participantsMatched) continue;
    if (args.memberCount !== undefined && chat.memberCount == null && meta.members.length !== args.memberCount) continue;
    matches.push({ chatId: chat.id, title: meta.title, titleSource: meta.titleSource, type: chat.type, memberCount: chat.memberCount ?? meta.members.length,
      unreadCount: chat.unreadCount, members: meta.members.map(m => ({ userId: m.userId, name: m.name })),
      matchedBy: titleMatched ? 'title' : participantsMatched ? 'participants' : 'memberCount' });
  }
  const incomplete = scanned < chats.length;
  const nextCursor = incomplete ? Buffer.from(JSON.stringify({ binding, offset: scanned })).toString('base64url') : null;
  return { matches, ambiguous: matches.length > 1 || incomplete || offset > 0, incomplete, nextCursor,
    searched: scanned - offset, metadataFetched: inspected, totalLoaded: chats.length,
    searchLimitations: 'Only loaded rooms are searched. Follow every nextCursor and combine matches before selecting a room; a single page cannot establish uniqueness. Phone-local names or transliteration may differ: use list_chats or participants if needed. Never send to a first candidate automatically.' };

}

export function registerChatDiscoveryTools(server: McpStdioServer, kakao: DiscoverySession) {
  server.registerTool({
    name: 'find_chat',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'Find loaded rooms by title, participant names, or member count (all provided filters must match). Follow nextCursor to search subsequent pages and combine results before deciding uniqueness. Returns candidates and ambiguity, never creates a room or sends/reads messages. Phone-local titles may differ. Confirm the exact room when ambiguous.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200 },
      refresh: { type: 'boolean', description: 'Refresh metadata instead of relying on resolved cached titles; useful after a rename.' },
      cursor: { type: 'string', maxLength: 1024, description: 'nextCursor from the preceding page of the same search.' },
      participants: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 10 },
      memberCount: { type: 'integer', minimum: 1 }
    }, additionalProperties: false },
    handler: async args => markUntrusted(await findChatCandidates(kakao, args))
  });
}
