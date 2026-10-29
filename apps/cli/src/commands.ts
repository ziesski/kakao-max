// ----------------------------------------------------------------------------
// Commands that map one-to-one onto a daemon MCP tool. Each prints the tool's JSON
// result; authorization, approvals and limits stay in the daemon. Writes reuse the
// same one-requestId lifecycle as `kakao send` (see agent-send-client.ts).
// ----------------------------------------------------------------------------

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { KakaoError } from '@kakao-max/core';

export type WriteKind = 'send' | 'mutation' | 'operation';
type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | string[] | undefined>;

export interface CliContext {
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** One approved write under the command's requestId; repeating the same --request-id continues it. */
  write(tool: string, args: Record<string, unknown>, kind: WriteKind): Promise<any>;
  /** Exact chat ID of an already-loaded room (#N, ID, self, or unique name). */
  room(target: string): Promise<string>;
  requestId: string;
}

export interface Command {
  usage: string;
  summary: string;
  /** Optional daemon tool group the command needs (KAKAO_MCP_TOOL_GROUPS). */
  group?: 'chats' | 'friends' | 'events' | 'vault';
  options?: Options;
  /** Positionals the command needs; the rest are optional or variadic. */
  required?: number;
  run(cli: CliContext, args: string[], values: Values): Promise<unknown>;
}

function int(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new KakaoError('INVALID_ARGUMENT', `${name} must be a whole number`);
  return n;
}

function userId(raw: string): string {
  if (!/^[1-9]\d{0,18}$/.test(raw)) throw new KakaoError('INVALID_ARGUMENT', 'userId must be a numeric user ID');
  return raw;
}

/** Drops undefined fields so the daemon's strict schemas only see what was given. */
function defined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

const readGrant: Options = { 'read-grant': { type: 'string' } };
const limit: Options = { limit: { type: 'string' } };
const grantArg = (values: Values) => values['read-grant'] as string | undefined;

export const COMMANDS: Record<string, Command> = {
  // --- Rooms and people (read-only) ---------------------------------------------------------------
  'find-room': {
    usage: 'find-room [검색어] [--participant <이름>]... [--members <인원>] [--refresh] [--cursor <c>]',
    summary: '제목·참여자·인원수로 대화방 찾기 (모호하면 후보와 nextCursor 표시)',
    options: { participant: { type: 'string', multiple: true }, members: { type: 'string' }, refresh: { type: 'boolean' }, cursor: { type: 'string' } },
    run: (cli, [query], v) => cli.call('find_chat', defined({ query, participants: v.participant, memberCount: int(v.members, '--members'),
      refresh: v.refresh || undefined, cursor: v.cursor }))
  },
  dm: {
    usage: 'dm <친구이름 또는 userId>', summary: '친구와의 1:1 방 찾기 (없으면 needsCreate와 userId; 만들기는 create-dm)', group: 'chats', required: 1,
    run: (cli, [query]) => cli.call('open_direct_chat', { query })
  },
  members: {
    usage: 'members <대화방> <userId>...', summary: '방 참여자 이름·프로필 조회 (최대 100명)', group: 'chats', required: 2,
    run: async (cli, [room, ...ids]) => cli.call('get_members', { chatId: await cli.room(room), userIds: ids.map(userId) })
  },
  meta: {
    usage: 'meta <대화방> <metaType>... [--read-grant <id>]', summary: '방 공유 정보 조회 (예: 1 = 공지)', group: 'chats', required: 2, options: readGrant,
    run: async (cli, [room, ...types], v) => cli.call('get_chat_meta', defined({ chatId: await cli.room(room),
      types: types.map(t => int(t, 'metaType')), readGrantId: grantArg(v) }))
  },
  unread: {
    usage: 'unread <대화방> --read-grant <id> [--limit <1-20>]', summary: '안읽음 표시를 지우지 않고 수신 본문 미리보기 (수동 규칙과 읽기 허가 필요)', required: 1,
    options: { ...readGrant, ...limit },
    run: async (cli, [room], v) => {
      if (!grantArg(v)) throw new KakaoError('INVALID_ARGUMENT', 'preview_unread needs --read-grant (allow-read --tools preview_unread)');
      return cli.call('preview_unread', defined({ chatId: await cli.room(room), readGrantId: grantArg(v), limit: int(v.limit, '--limit') }));
    }
  },
  'sync-friends': {
    usage: 'sync-friends', summary: '카카오 서버에서 친구 목록 전체 새로고침', group: 'friends',
    run: cli => cli.call('sync_friends')
  },
  blocked: {
    usage: 'blocked [--no-resolve]', summary: '차단한 사용자 목록', group: 'friends', options: { 'no-resolve': { type: 'boolean' } },
    run: (cli, _, v) => cli.call('list_blocked_users', { resolveMembers: v['no-resolve'] !== true })
  },
  profile: {
    usage: 'profile [--profile-id <id>]', summary: '내 프로필과 멀티프로필', group: 'friends', options: { 'profile-id': { type: 'string' } },
    run: (cli, _, v) => cli.call('get_my_profile', defined({ profileId: v['profile-id'] }))
  },
  'friend-profile': {
    usage: 'friend-profile <userId>', summary: '친구 프로필 조회', group: 'friends', required: 1,
    run: (cli, [id]) => cli.call('get_friend_profile', { userId: userId(id) })
  },

  // --- Permissions, pause and approvals ------------------------------------------------------------
  perms: {
    usage: 'perms', summary: '허가 목록: 묻지 않고 보내는 방, 읽기 규칙, 일회성 읽기 허가',
    run: cli => cli.call('list_permissions')
  },
  revoke: {
    usage: 'revoke <recipient:<chatId> | room:<chatId> | 읽기허가ID>', summary: '허가 즉시 철회 (승인 불필요)', required: 1,
    run: (cli, [permissionId]) => cli.call('revoke_permission', { permissionId })
  },
  allow: {
    usage: 'allow <대화방>', summary: '이 방의 이후 메시지·사진을 묻지 않고 보내도록 허가 요청 (사람 승인)', required: 1,
    run: async (cli, [room]) => cli.write('request_permission', { chatId: await cli.room(room), type: 'send' }, 'operation')
  },
  'allow-read': {
    usage: 'allow-read <대화방> [--tools read_messages,download_attachment,...] [--max <1-100>] [--uses <1-20>] [--ttl <분>]',
    summary: '닫힌 방의 일회성 읽기 허가 요청 (승인 후 readGrantId 출력)', required: 1,
    options: { tools: { type: 'string' }, max: { type: 'string' }, uses: { type: 'string' }, ttl: { type: 'string' } },
    run: async (cli, [room], v) => cli.write('request_permission', defined({ chatId: await cli.room(room), type: 'read',
      tools: typeof v.tools === 'string' ? v.tools.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      maxMessages: int(v.max, '--max'), uses: int(v.uses, '--uses'), ttlMinutes: int(v.ttl, '--ttl') }), 'operation')
  },
  'room-rule': {
    usage: 'room-rule <대화방> <manual|scheduled|immediate> [--max <n>] [--calls-per-hour <n>] [--expires <ISO8601>] [--schedule <json>]',
    summary: '방 읽기 규칙 변경 요청 (사람 승인)', required: 2,
    options: { max: { type: 'string' }, 'calls-per-hour': { type: 'string' }, expires: { type: 'string' }, schedule: { type: 'string' } },
    run: async (cli, [room, mode], v) => {
      let schedule: unknown;
      if (typeof v.schedule === 'string') {
        try { schedule = JSON.parse(v.schedule); } catch { throw new KakaoError('INVALID_ARGUMENT', '--schedule must be JSON, e.g. {"timeZone":"Asia/Seoul","times":["09:00"],"windowMinutes":30}'); }
      }
      const rule = defined({ mode, maxMessages: int(v.max, '--max'), callsPerHour: int(v['calls-per-hour'], '--calls-per-hour'), expiresAt: v.expires, schedule });
      return cli.write('request_permission', { chatId: await cli.room(room), type: 'room_access', rule }, 'operation');
    }
  },
  'room-default': {
    usage: 'room-default <대화방>', summary: '저장된 읽기 규칙을 지우고 기본값으로 (더 넓어지면 사람 승인)', required: 1,
    // Narrowing answers at once without an operation record, so this is a plain call, not an acknowledged write.
    run: async (cli, [room]) => cli.call('request_permission', { requestId: cli.requestId, chatId: await cli.room(room), type: 'room_default' })
  },
  pause: {
    usage: 'pause', summary: '긴급 중단: 모든 전송과 계정 변경을 즉시 막음 (승인 불필요)',
    run: cli => cli.call('pause', { paused: true })
  },
  resume: {
    usage: 'resume', summary: '중단 해제 요청 (사람 승인 후 같은 --request-id로 다시 실행)',
    run: async cli => {
      const out = await cli.call<{ paused: boolean }>('pause', { paused: false, requestId: cli.requestId });
      if (out.paused) throw new KakaoError('APPROVAL_REQUIRED', `Sending is still paused; approve the release, then run again with --request-id ${cli.requestId}`);
      return out;
    }
  },
  wait: {
    usage: 'wait <requestId> [--timeout <ms>]', summary: '패스키 페이지에서 사람이 결정할 때까지 대기', required: 1, options: { timeout: { type: 'string' } },
    run: (cli, [requestId], v) => cli.call('wait_for_approval', defined({ requestId, timeoutMs: int(v.timeout, '--timeout') }))
  },
  op: {
    usage: 'op <requestId>', summary: '요청 처리 상태 조회 (내용 없음)', required: 1,
    run: (cli, [requestId]) => cli.call('get_operation', { requestId })
  },

  // --- Messages and account changes (approved writes) ----------------------------------------------
  edit: {
    usage: 'edit <대화방> <logId> "<새 내용>"', summary: '내 메시지 수정 (사람 승인)', required: 3,
    run: async (cli, [room, logId, ...text]) => cli.write('edit_or_delete_message', { action: 'edit', chatId: await cli.room(room), logId, text: text.join(' ') }, 'mutation')
  },
  delete: {
    usage: 'delete <대화방> <logId>', summary: '내 메시지 모두에게서 삭제 (사람 승인)', required: 2,
    run: async (cli, [room, logId]) => cli.write('edit_or_delete_message', { action: 'delete', chatId: await cli.room(room), logId }, 'mutation')
  },
  hide: {
    usage: 'hide <대화방> <logId>...', summary: '이 데몬에서만 메시지 숨기기 (카카오톡에는 변화 없음)', group: 'chats', required: 2,
    run: async (cli, [room, ...logIds]) => cli.call('self_delete_messages', { chatId: await cli.room(room), logIds })
  },
  forward: {
    usage: 'forward <대화방> "<내용>" [--type <n>] [--extra <첨부JSON>]', summary: '메시지 내용(첨부 JSON 포함) 전달 (항상 사람 승인)', group: 'chats', required: 2,
    options: { type: { type: 'string' }, extra: { type: 'string' } },
    run: async (cli, [room, ...text], v) => cli.write('forward_message', defined({ chatId: await cli.room(room), text: text.join(' '),
      type: int(v.type, '--type'), extra: v.extra }), 'send')
  },
  emoticon: {
    usage: 'emoticon <대화방> <원본대화방> <원본logId>', summary: '저장된 메시지의 이모티콘 보내기 (사람 승인)', group: 'chats', required: 3,
    run: async (cli, [room, from, fromLogId]) => cli.write('send_emoticon', { chatId: await cli.room(room), fromChatId: await cli.room(from), fromLogId }, 'mutation')
  },
  'set-meta': {
    usage: 'set-meta <대화방> <metaType> "<내용>"', summary: '방 공유 정보 변경, 모든 참여자에게 보임 (예: 1 = 공지, 사람 승인)', group: 'chats', required: 3,
    run: async (cli, [room, type, ...content]) => cli.write('set_chat_meta', { chatId: await cli.room(room), type: int(type, 'metaType'), content: content.join(' ') }, 'operation')
  },
  leave: {
    usage: 'leave <대화방> [--silent] [--block]', summary: '방 나가기, 되돌릴 수 없음 (사람 승인)', group: 'chats', required: 1,
    options: { silent: { type: 'boolean' }, block: { type: 'boolean' } },
    run: async (cli, [room], v) => cli.write('leave_chat', defined({ chatId: await cli.room(room), silence: v.silent || undefined, block: v.block || undefined }), 'operation')
  },
  'create-dm': {
    usage: 'create-dm <userId>', summary: '친구와 1:1 방 만들기 (사람 승인)', group: 'chats', required: 1,
    run: (cli, [id]) => cli.write('create_direct_chat', { userId: userId(id) }, 'operation')
  },
  'add-friend': {
    usage: 'add-friend <userId>', summary: '친구 추가 (사람 승인, 하루 한도)', group: 'friends', required: 1,
    run: (cli, [id]) => cli.write('add_friend', { userId: userId(id) }, 'operation')
  },
  block: {
    usage: 'block <userId> [--profile]', summary: '사용자 차단 (--profile: 프로필도 차단, 사람 승인)', group: 'friends', required: 1,
    options: { profile: { type: 'boolean' } },
    run: (cli, [id], v) => cli.write('block_user', { userId: userId(id), blockType: v.profile ? 2 : 1 }, 'operation')
  },
  unblock: {
    usage: 'unblock <userId>', summary: '차단 해제 (사람 승인)', group: 'friends', required: 1,
    run: (cli, [id]) => cli.write('unblock_user', { userId: userId(id) }, 'operation')
  },
  'status-message': {
    usage: 'status-message <profileId> "<상태메시지>"', summary: '프로필 상태 메시지 변경, 빈 문자열은 지우기 (사람 승인)', group: 'friends', required: 2,
    run: (cli, [profileId, ...text]) => cli.write('update_my_profile', { profileId, statusMessage: text.join(' ') }, 'mutation')
  },

  // --- Durable message events ---------------------------------------------------------------------
  'events-claim': {
    usage: 'events-claim <대화방> --consumer <이름> [--limit <n>] [--lease-ms <ms>] [--read-grant <id>]',
    summary: '수신 메시지 이벤트 가져오기 (처리 후 events-ack)', group: 'events', required: 1,
    options: { consumer: { type: 'string' }, 'lease-ms': { type: 'string' }, ...limit, ...readGrant },
    run: async (cli, [room], v) => {
      if (typeof v.consumer !== 'string') throw new KakaoError('INVALID_ARGUMENT', '--consumer is required');
      return cli.call('claim_message_events', defined({ chatId: await cli.room(room), consumer: v.consumer, limit: int(v.limit, '--limit'),
        leaseMs: int(v['lease-ms'], '--lease-ms'), readGrantId: grantArg(v) }));
    }
  },
  'events-ack': {
    usage: 'events-ack <대화방> --consumer <이름> --generation <sourceGeneration> <eventId:leaseId>... [--read-grant <id>]',
    summary: '처리를 마친 이벤트 확인', group: 'events', required: 2,
    options: { consumer: { type: 'string' }, generation: { type: 'string' }, ...readGrant },
    run: async (cli, [room, ...pairs], v) => {
      if (typeof v.consumer !== 'string' || typeof v.generation !== 'string') throw new KakaoError('INVALID_ARGUMENT', '--consumer and --generation are required');
      const events = pairs.map(pair => {
        const [eventId, leaseId, ...rest] = pair.split(':');
        if (!eventId || !leaseId || rest.length) throw new KakaoError('INVALID_ARGUMENT', 'Each event is eventId:leaseId');
        return { eventId, leaseId };
      });
      return cli.call('ack_message_events', defined({ chatId: await cli.room(room), consumer: v.consumer, sourceGeneration: v.generation, events, readGrantId: grantArg(v) }));
    }
  },

  // --- Local vault ---------------------------------------------------------------------------------
  'vault-export': {
    usage: 'vault-export <대화방> <json|html> [--title <제목>] [--limit <n>] [--read-grant <id>]',
    summary: '대화 내역을 데몬의 vault/exports/ 에 파일로 내보내기', group: 'vault', required: 2,
    options: { title: { type: 'string' }, ...limit, ...readGrant },
    run: async (cli, [room, format], v) => cli.call('export_chat_history', defined({ chatId: await cli.room(room), format, title: v.title,
      limit: int(v.limit, '--limit'), readGrantId: grantArg(v) }))
  },
  'vault-links': {
    usage: 'vault-links <대화방> [--limit <n>] [--read-grant <id>]', summary: '방에서 공유된 링크 모아 분류', group: 'vault', required: 1,
    options: { ...limit, ...readGrant },
    run: async (cli, [room], v) => cli.call('collect_shared_links', defined({ chatId: await cli.room(room), limit: int(v.limit, '--limit'), readGrantId: grantArg(v) }))
  },
  'vault-schedule': {
    usage: 'vault-schedule <대화방> [--limit <n>] [--read-grant <id>]', summary: '방에서 약속·일정·할 일 추출', group: 'vault', required: 1,
    options: { ...limit, ...readGrant },
    run: async (cli, [room], v) => cli.call('extract_schedule_and_todos', defined({ chatId: await cli.room(room), limit: int(v.limit, '--limit'), readGrantId: grantArg(v) }))
  },
  'vault-search': {
    usage: 'vault-search "<검색어>" <대화방>... [--limit <n>] [--read-grant <id>]', summary: '여러 방에서 한 번에 검색 (모든 방이 허용돼야 함)', group: 'vault', required: 2,
    options: { ...limit, ...readGrant },
    run: async (cli, [query, ...rooms], v) => {
      const chatIds: string[] = [];
      for (const room of rooms) chatIds.push(await cli.room(room));
      return cli.call('search_vault', defined({ chatIds, query, limit: int(v.limit, '--limit'), readGrantId: grantArg(v) }));
    }
  },
  'vault-stats': {
    usage: 'vault-stats', summary: 'vault 저장 통계 (내용 없음)', group: 'vault',
    run: cli => cli.call('get_vault_stats')
  }
};

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Strict flags per command: an unknown flag or a missing argument is an error, never silently ignored. */
export function parseCommand(name: string, argv: string[]): { command: Command; args: string[]; values: Values; requestId?: string } {
  const command = COMMANDS[name];
  if (!command) throw new KakaoError('INVALID_ARGUMENT', `Unknown command: ${name}`);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...command.options, 'request-id': { type: 'string' } }, allowPositionals: true, strict: true });
  } catch (cause) {
    throw new KakaoError('INVALID_ARGUMENT', `${(cause as Error).message}\n사용법: kakao ${command.usage}`, { cause });
  }
  const { positionals, values } = parsed;
  if (positionals.length < (command.required ?? 0)) throw new KakaoError('INVALID_ARGUMENT', `사용법: kakao ${command.usage}`);
  const requestId = values['request-id'] as string | undefined;
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw new KakaoError('INVALID_ARGUMENT', '--request-id must be the UUID printed by the earlier run');
  return { command, args: positionals, values: values as Values, requestId };
}
