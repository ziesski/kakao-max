import { KakaoError, type KakaoSession } from '@kakao-max/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import { readGrant } from '../read-grant.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function registerVaultTools(server: McpStdioServer, kakao: KakaoSession): void {
  // 1. export_chat_history
  server.registerTool({
    name: 'export_chat_history',
    group: 'vault',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Export authorized chat history to an immutable file inside vault/exports/ in JSON or responsive HTML book format. ' +
      'Requires room read authorization (RoomAccessPolicy). Destination path is fixed under dataDir/vault/exports/ and cannot be chosen by callers.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Canonical room ID' },
        format: { type: 'string', enum: ['json', 'html'], description: 'Export format: "json" or "html"' },
        title: { type: 'string', description: 'Optional custom title in export header' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Max messages to export (default 1000)' },
        readGrantId: { type: 'string', description: 'Manual room read grant ID if room rule requires it' }
      },
      required: ['chatId', 'format'],
      additionalProperties: false
    },
    handler: async (args) => {
      const chatId = String(args.chatId);
      const format = args.format as 'json' | 'html';
      const grant = readGrant(args, 'export_chat_history');
      const res = await kakao.exportChatHistory(chatId, {
        format,
        title: args.title ? String(args.title) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        ...grant
      });
      return markUntrusted(res);
    }
  });

  // 2. collect_shared_links
  server.registerTool({
    name: 'collect_shared_links',
    group: 'vault',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Extract and categorize shared URLs (YouTube, GitHub, Figma, articles, social, docs) from an authorized chat. ' +
      'Requires room read authorization (RoomAccessPolicy).' + UNTRUSTED_TOOL_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Canonical room ID' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max messages to inspect (default 500)' },
        readGrantId: { type: 'string', description: 'Manual room read grant ID if room rule requires it' }
      },
      required: ['chatId'],
      additionalProperties: false
    },
    handler: async (args) => {
      const chatId = String(args.chatId);
      const grant = readGrant(args, 'collect_shared_links');
      const res = await kakao.collectSharedLinks(chatId, {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        ...grant
      });
      return markUntrusted(res);
    }
  });

  // 3. extract_schedule_and_todos
  server.registerTool({
    name: 'extract_schedule_and_todos',
    group: 'vault',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Extract appointments, schedule times, locations, and action items/todos from an authorized chat. ' +
      'Requires room read authorization (RoomAccessPolicy).' + UNTRUSTED_TOOL_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Canonical room ID' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max messages to inspect (default 500)' },
        readGrantId: { type: 'string', description: 'Manual room read grant ID if room rule requires it' }
      },
      required: ['chatId'],
      additionalProperties: false
    },
    handler: async (args) => {
      const chatId = String(args.chatId);
      const grant = readGrant(args, 'extract_schedule_and_todos');
      const res = await kakao.extractScheduleAndTodos(chatId, {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        ...grant
      });
      return markUntrusted(res);
    }
  });

  // 4. search_vault
  server.registerTool({
    name: 'search_vault',
    group: 'vault',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Search messages across specified authorized rooms. ' +
      'Requires explicit chatIds array. Every room is verified against RoomAccessPolicy; if even one room is denied, the entire call is rejected.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        chatIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Array of canonical room IDs to search across'
        },
        query: { type: 'string', description: 'Keyword or phrase to search' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max matches per room (default 20)' },
        readGrantId: { type: 'string', description: 'Manual room read grant ID if room rule requires it' }
      },
      required: ['chatIds', 'query'],
      additionalProperties: false
    },
    handler: async (args) => {
      const chatIds = Array.isArray(args.chatIds) ? args.chatIds.map((c: unknown) => String(c)) : [];
      const query = String(args.query);
      const grant = readGrant(args, 'search_vault');
      const res = await kakao.searchVault({
        chatIds,
        query,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        ...grant
      });
      return markUntrusted(res);
    }
  });

  // 5. get_vault_stats
  server.registerTool({
    name: 'get_vault_stats',
    group: 'vault',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Get high-level storage stats for the local vault (file counts, total bytes, export count) without revealing private contents or chat titles.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    handler: async () => {
      return kakao.getVaultStats();
    }
  });
}
