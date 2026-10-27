// Optional "friends" group: address book, blocks and profiles (read-only). Friend, block and profile
// changes are named operations or mutations that always need human approval.
import { KakaoError, type KakaoSession } from '@kakao-max/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function registerFriendsTools(server: McpStdioServer, kakao: KakaoSession): void {
  server.registerTool({
    name: 'sync_friends',
    group: 'friends',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Force a full refresh of the friends list from the Kakao servers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true, totalFriends: await kakao.syncFriends(true) })
  });

  server.registerTool({
    name: 'list_blocked_users',
    group: 'friends',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'List blocked users: IDs, block types (1 = messages, 2 = messages and profile) and resolved member profiles if available.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: {
      resolveMembers: { type: 'boolean', description: 'Resolve member profiles via BLMEMBER (default true).' }
    }, additionalProperties: false },
    handler: async args => {
      const res = await kakao.getBlockList({ resolveMembers: args.resolveMembers !== false });
      return markUntrusted({ count: res.blockIds.length, revision: res.revision, blockIds: res.blockIds, blockTypes: res.blockTypes, members: res.members });
    }
  });

  server.registerTool({
    name: 'get_my_profile',
    group: 'friends',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'My profile and multi-profiles: nickname, status message, image URLs, decoration and photo history.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: {
      profileId: { type: 'string', description: 'A specific multi-profile; omitted = the main profile.' }
    }, additionalProperties: false },
    handler: async args => {
      const profileId = typeof args.profileId === 'string' && args.profileId.trim() ? args.profileId.trim() : undefined;
      const res = await kakao.getMyProfile(profileId);
      return markUntrusted({ profile: res.profile, profilesCount: res.profiles.length, profiles: res.profiles });
    }
  });

  server.registerTool({
    name: 'get_friend_profile',
    group: 'friends',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'A friend\'s profile by numeric userId: status message, image URLs, decoration, profile music, photo history and account status.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'], additionalProperties: false },
    handler: async args => {
      if (!/^\d+$/.test(String(args.userId))) throw new KakaoError('INVALID_ARGUMENT', 'userId must be numeric');
      return markUntrusted(await kakao.getFriendProfile(String(args.userId)));
    }
  });
}
