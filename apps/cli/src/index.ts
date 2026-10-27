#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, toKakaoError, programArgs, installRoot, KakaoError } from '@kakao-max/core';
import { resolveRoom } from './room-resolution.ts';
import { randomUUID } from 'node:crypto';
import { sendMessage, sendPhotos, submitWrite, approvalLink } from './agent-send-client.ts';
import { runAgentFileCommand, readAgentRequest } from './agent-send-files.ts';
import { McpClient, McpToolError } from './mcp-client.ts';
import { readRoomSmokeAccess } from './smoke-read-scope.ts';
import { runChatShell } from './chat-shell.ts';
import { runTerminalMessenger } from './terminal-messenger.ts';
import { messageAttachments, mediaTypeName, parseMediaType } from './attachments.ts';
import { COMMANDS, parseCommand, type CliContext } from './commands.ts';
import { renderCommand, renderOverview, suggest, type Paint } from './help.ts';

// ----------------------------------------------------------------------------
// CLI and terminal messenger share the daemon's MCP policies and connection.
// ----------------------------------------------------------------------------
const config = loadConfig();
const MCP_HOST = config.mcpHost, MCP_PORT = config.mcpPort;
const DATA_DIR = config.dataDir;

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

interface ChatItem {
  id: string;
  type?: string;
  unreadCount?: number | null;
  lastMessage?: string;
  lastSendAt?: number;
  title?: string;
  isGroup?: boolean;
  memberCount?: number;
  maxLogId?: string | number;
}

interface ServerState {
  userId?: string;
  connected: boolean;
  endpoint?: { host: string; port: number };
  chats: ChatItem[];
}

// ----------------------------------------------------------------------------
// High-Level Data Provider
// ----------------------------------------------------------------------------

interface KakaoBackend {
  getState(): Promise<ServerState>;
  sendMessage(chatId: string, text: string, requestId: string): Promise<{ status: number; logId?: string }>;
  sendMedia(chatId: string, filePath: string, type: number, requestId: string): Promise<{ status: number; logId?: string }>;
  markRead(chatId: string, watermark: string, requestId: string): Promise<any>;
  getRoomAccess(chatId: string): Promise<{ rule: { mode: string } }>;
  getHistory(chatId: string, limit?: number, readGrantId?: string, requestId?: string): Promise<{ title?: string; members?: Record<string, { name: string }>; messages: any[]; sync?: any; untrusted?: boolean }>;
  searchMessages(query: string, chatId: string, limit?: number, readGrantId?: string, requestId?: string): Promise<{ count: number; messages: any[] }>;
  downloadMedia(chatId: string, token: string, outputPath: string, type?: number, isMini?: boolean, messageId?: string, readGrantId?: string): Promise<any>;
  listFriends(query?: string, limit?: number): Promise<{ count: number; friends: any[] }>;
  syncFriends(): Promise<{ ok: boolean; totalFriends: number }>;
}

// The CLI only talks to the MCP daemon — the same surface agents use.
async function getBackend(): Promise<KakaoBackend> {
  const mcp = new McpClient({ host: MCP_HOST, port: MCP_PORT });
  try {
    await mcp.connect();
  } catch (e) {
    console.error(`\n${c.red}${c.bold}❌ 카카오톡 MCP 데몬(${MCP_HOST}:${MCP_PORT})에 연결할 수 없습니다.${c.reset} ${c.dim}${(e as Error).message}${c.reset}`);
    console.error(`${c.gray}데몬을 실행하거나 터널을 여세요:${c.reset}`);
    console.error(`  • 로컬 데몬:  ${c.cyan}KAKAO_MCP_LISTEN=127.0.0.1:8787 npm run start --workspace=@kakao-max/mcp${c.reset}`);
    console.error(`  • 원격 터널:  ${c.cyan}ssh -N -L 8787:127.0.0.1:8787 <서버>${c.reset}\n`);
    process.exit(1);
  }
  const tool = <T = any>(name: string, args: Record<string, unknown> = {}) => mcp.callTool<T>(name, args);

  return {
    async getState() {
      const [s, l] = await Promise.all([tool('get_status'), tool('list_chats')]);
      return { userId: s.userId, connected: s.connected, endpoint: s.endpoint, chats: l.chats || [] };
    },
    // Sends to a room the person has not allowed ask for approval; naming a room is not approval proof.
    sendMessage: (chatId, text, requestId) => sendMessage(mcp, { chatId, text }, requestId),
    async sendMedia(chatId, filePath, type, requestId) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const bytes = await fs.readFile(filePath);
      try { return await sendPhotos(mcp, { chatId, dataBase64: bytes.toString('base64'), fileName: path.basename(filePath), type }, requestId); }
      finally { bytes.fill(0); }
    },
    // A read receipt always needs approval (and the daemon's chats tool group).
    markRead: (chatId, watermark, requestId) => submitWrite(mcp, 'mark_read', { chatId, watermark, requestId }, 'operation'),
    getRoomAccess: async chatId => (await tool('list_chats', { chatId })).access,
    // A closed room answers APPROVAL_REQUIRED naming requestId; repeating that requestId after approval reads once.
    getHistory: (chatId, limit = 50, readGrantId, requestId) =>
      tool('read_messages', { chatId, limit, ...(readGrantId ? { readGrantId } : requestId ? { requestId } : {}) }),
    searchMessages: (query, chatId, limit = 20, readGrantId, requestId) =>
      tool('read_messages', { mode: 'search', query, chatId, limit, ...(readGrantId ? { readGrantId } : requestId ? { requestId } : {}) }),
    // The daemon may run on another host: take the bytes and write them here, never at a daemon path.
    downloadMedia: async (chatId, token, outputPath, type = 2, isMini = false, messageId, readGrantId) => {
      const res = await tool('download_attachment', { chatId, token, type, isMini, messageId, ...(readGrantId ? { readGrantId } : {}) });
      await fs.promises.writeFile(outputPath, Buffer.from(String(res.dataBase64), 'base64'), { flag: 'wx' });
      return { status: res.status, size: res.size, outputPath };
    },
    listFriends: (query, limit = 50) => tool('list_friends', { query, limit }),
    syncFriends: () => tool('sync_friends')
  };
}

// ----------------------------------------------------------------------------
// Helpers: Target Resolver
// ----------------------------------------------------------------------------

// LOCO type codes: MultiChat / OM (open group) are groups; see packages/core/src/chat-types.ts.
function isDirectChat(c: ChatItem): boolean {
  if (c.type === 'MultiChat' || c.type === 'OM') return false;
  if (c.isGroup === true) return false;
  if (c.memberCount && c.memberCount > 2) return false;
  return c.type === 'DirectChat' || !c.isGroup;
}


function formatTime(sec?: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  const clean = str.replace(/\n/g, ' ');
  return clean.length > len ? clean.slice(0, len - 1) + '…' : clean;
}

// ----------------------------------------------------------------------------
// CLI Commands
// ----------------------------------------------------------------------------

async function cmdList() {
  const backend = await getBackend();
  const state = await backend.getState();

  console.log(`\n${c.bold}💬 카카오톡 대화방 목록${c.reset} ${c.gray}(총 ${state.chats.length}개 방 | ${state.connected ? c.green + '● 온라인' : c.red + '○ 오프라인'}${c.gray})${c.reset}\n`);

  if (state.chats.length === 0) {
    console.log(`${c.yellow}대화방이 없습니다.${c.reset}\n`);
    return;
  }

  // Table header
  console.log(
    ` ${c.dim}#${c.reset}   ` +
    `${c.dim}안읽음${c.reset}  ` +
    `${c.dim}구분${c.reset}  ` +
    `${c.bold}${'대화방 이름'.padEnd(24)}${c.reset}  ` +
    `${c.dim}${'시간'.padEnd(6)}${c.reset}  ` +
    `${c.dim}최근 메시지${c.reset}`
  );
  console.log(`${c.gray}${'─'.repeat(80)}${c.reset}`);

  state.chats.forEach((chat, i) => {
    const idx = String(i + 1).padStart(2);
    const unread = chat.unreadCount && chat.unreadCount > 0
      ? `${c.red}${c.bold}${String(chat.unreadCount).padStart(3)}${c.reset}   `
      : `${c.gray}  -   ${c.reset}`;
    const isMemo = chat.title === '나와의 채팅' || chat.type === 'MemoChat';
    const isDirect = isDirectChat(chat);
    const typeLabel = isMemo
      ? `${c.magenta}나  ${c.reset}`
      : isDirect
      ? `${c.gray}1:1 ${c.reset}`
      : `${c.cyan}그룹${c.reset}`;
    const title = truncate(chat.title || `Chat-${chat.id}`, 20).padEnd(20);
    const time = (formatTime(chat.lastSendAt) || '-').padEnd(6);
    const msg = c.dim + truncate(chat.lastMessage || '(내용 없음)', 30) + c.reset;

    console.log(` ${c.yellow}${idx}${c.reset}   ${unread} ${typeLabel}  ${c.bold}${title}${c.reset}  ${c.dim}${time}${c.reset}  ${msg}`);
  });

  console.log(`\n${c.gray}💡 사용법: ${c.cyan}kakao send <#번호 또는 이름> "메시지"${c.gray} 로 바로 발송할 수 있습니다.${c.reset}\n`);
}

/** Approval pending: show the link and how to continue with the same request ID; otherwise the failure. */
function reportWriteError(e: any, requestId: string): void {
  if (e.code === 'APPROVAL_REQUIRED') {
    const link = approvalLink(e);
    console.log(`\r${c.yellow}⏳ [승인 필요]${c.reset} ${link ? `이 링크에서 승인하세요: ${c.cyan}${link}${c.reset}` : e.message}`);
    console.log(`${c.gray}승인한 뒤 같은 명령에 --request-id ${requestId} 를 붙여 다시 실행하세요.${c.reset}`);
    return;
  }
  const unknown = e.code === 'SEND_OUTCOME_UNKNOWN' || e.code === 'MUTATION_OUTCOME_UNKNOWN';
  console.log(`\r${c.red}❌ [${unknown ? '결과 불확실 — 휴대폰 확인 필요, 다시 보내지 마세요' : '실패'}]${c.reset} ${e.message}`);
}

async function cmdSend(targetArg: string, messageArg: string, requestId: string = randomUUID()) {
  if (!targetArg || !messageArg) {
    console.error(`\n${c.red}❌ 사용법: kakao send <#번호 또는 이름 또는 self> "<메시지>"${c.reset}\n`);
    console.error(`  예시:`);
    console.error(`    kakao send self "나한테 보내는 메모"`);
    console.error(`    kakao send 1 "안녕하세요!"`);
    console.error(`    kakao send "김철수" "자료 확인했습니다."\n`);
    process.exit(1);
  }

  const backend = await getBackend();
  const state = await backend.getState();

  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방이나 친구를 찾을 수 없습니다: "${targetArg}"${c.reset}`);
    console.error(`${c.gray}'kakao friends' 또는 'kakao ls' 명령어로 대화 상대나 방을 확인해주세요.${c.reset}\n`);
    process.exit(1);
  }

  const roomName = chat.title || chat.id;
  process.stdout.write(`${c.dim}[전송 중...]${c.reset} ${c.bold}${roomName}${c.reset} 에게 발송 중... `);

  try {
    const res = await backend.sendMessage(chat.id, messageArg, requestId);
    console.log(`\r${c.green}${c.bold}✅ [전송 완료]${c.reset} ${c.bold}${roomName}${c.reset}: "${messageArg}" ${c.gray}(logId: ${res.logId})${c.reset}`);
  } catch (e: any) {
    process.exitCode = 1;
    reportWriteError(e, requestId);
  }
}

async function cmdSendMedia(targetArg: string, filePath: string, type: number = 2, requestId: string = randomUUID()) {
  if (!targetArg || !filePath) {
    console.error(`\n${c.red}❌ 사용법: kakao send-photo <대화방> <파일경로>${c.reset}\n`);
    process.exit(1);
  }

  const backend = await getBackend();
  const state = await backend.getState();
  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방을 찾을 수 없습니다: "${targetArg}"${c.reset}\n`);
    process.exit(1);
  }

  process.stdout.write(`${c.dim}[전송 중]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} 으로 파일 전송 중 (${filePath})... `);
  try {
    const res = await backend.sendMedia(chat.id, filePath, type, requestId);
    console.log(`\r${c.green}✅ [전송 완료]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} (logId: ${c.cyan}${res.logId}${c.reset})\n`);
  } catch (e: any) {
    process.exitCode = 1;
    reportWriteError(e, requestId);
  }
}

async function cmdDownloadMedia(targetArg: string, token: string, outputPath: string, type: number, isMini = false, messageId?: string, readGrantId?: string) {
  if (!targetArg || !token || !outputPath || !messageId) {
    console.error(`\n${c.red}❌ 사용법: kakao download <대화방> <token> <저장경로> --message-id <logId> [--type photo|video|audio|file] [--mini] [--read-grant <id>]${c.reset}`);
    console.error(`${c.gray}token, message-id, type 은 'kakao history <대화방>' 의 📎 줄에 나옵니다.${c.reset}\n`);
    process.exit(1);
  }

  const backend = await getBackend();
  const state = await backend.getState();
  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방을 찾을 수 없습니다: "${targetArg}"${c.reset}\n`);
    process.exit(1);
  }

  process.stdout.write(`${c.dim}[다운로드 중]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} 에서 미디어 다운로드 중... `);
  try {
    const res = await backend.downloadMedia(chat.id, token, outputPath, type, isMini, messageId, readGrantId);
    console.log(`\r${c.green}✅ [다운로드 완료]${c.reset} ${c.cyan}${outputPath}${c.reset} (${res.size || 'N/A'} bytes)\n`);
  } catch (e: any) {
    process.exitCode = 1;
    console.log(`\r${c.red}❌ [다운로드 실패]${c.reset} ${e.message}\n`);
  }
}

async function cmdRead(targetArg: string, requestId: string = randomUUID()) {
  if (!targetArg) {
    console.error(`\n${c.red}❌ 사용법: kakao read <#번호 또는 이름 또는 self>${c.reset}\n`);
    process.exit(1);
  }

  const backend = await getBackend();
  const state = await backend.getState();
  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방을 찾을 수 없습니다: "${targetArg}"${c.reset}\n`);
    process.exit(1);
  }

  const watermark = chat.maxLogId || '0';
  try {
    await backend.markRead(chat.id, String(watermark), requestId);
    console.log(`\n${c.green}✅ [읽음 처리]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} 의 메시지를 모두 읽음 처리했습니다.\n`);
  } catch (e: any) {
    process.exitCode = 1;
    reportWriteError(e, requestId);
  }
}

async function cmdStatus() {
  const backend = await getBackend();
  const state = await backend.getState();

  console.log(`\n${c.bold}카카오톡 세션 연결 상태:${c.reset}`);
  console.log(`  • 상태:         ${state.connected ? c.green + '● 정상 연결됨 (Online)' : c.red + '○ 연결 끊김 (Offline)'}${c.reset}`);
  console.log(`  • 사용자 ID:    ${c.cyan}${state.userId || '확인 불가'}${c.reset}`);
  console.log(`  • 캐리지 서버:  ${state.endpoint ? `${state.endpoint.host}:${state.endpoint.port}` : '미할당'}`);
  console.log(`  • 대화방 수:    ${state.chats.length} 개 로드됨\n`);
}

async function cmdFriends(query?: string) {
  const backend = await getBackend();
  process.stdout.write(`${c.dim}[조회 중...]${c.reset} 카카오톡 친구 목록 조회 중... `);
  try {
    const res = await backend.listFriends(query, 50);
    const friends = res.friends || [];
    console.log(`\r${c.green}✅ [친구 목록]${c.reset} ${query ? `"${c.bold}${query}${c.reset}" 검색 결과: ` : ''}총 ${friends.length}명\n`);
    console.log(`${c.gray}${'─'.repeat(75)}${c.reset}`);
    for (let i = 0; i < friends.length; i++) {
      const f = friends[i];
      const name = f.friendNickName ? `${c.bold}${f.friendNickName}${c.reset} (${f.nickName})` : `${c.bold}${f.nickName}${c.reset}`;
      const status = f.statusMessage ? `${c.dim}"${truncate(f.statusMessage, 30)}"${c.reset}` : '';
      const uid = `${c.cyan}${f.userId}${c.reset}`;
      console.log(` ${c.yellow}${(i + 1).toString().padStart(2, ' ')}.${c.reset}  ${name.padEnd(35, ' ')} ${uid.padEnd(22, ' ')} ${status}`);
    }
    console.log(`${c.gray}${'─'.repeat(75)}${c.reset}`);
    console.log(`${c.dim}💡 1:1 대화방 열기: kakao history "<친구이름>" 또는 kakao send "<친구이름>" "<메시지>"${c.reset}\n`);
  } catch (e: any) {
    console.log(`\r${c.red}❌ [친구 조회 실패]${c.reset} ${e.message}\n`);
  }
}

async function cmdHistory(targetArg: string, limitArg?: string, readGrantId?: string, requestId: string = randomUUID()) {
  if (!targetArg) {
    console.error(`\n${c.red}❌ 사용법: kakao history <대화방/친구이름> [개수]${c.reset}\n`);
    process.exit(1);
  }
  const backend = await getBackend();
  const state = await backend.getState();
  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방이나 친구를 찾을 수 없습니다: "${targetArg}"${c.reset}\n`);
    process.exit(1);
  }

  const limit = Number(limitArg) || 20;
  process.stdout.write(`${c.dim}[조회 중...]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} 최근 ${limit}개 메시지 불러오는 중... `);
  try {
    const res = await backend.getHistory(chat.id, limit, readGrantId, requestId);
    const msgs = res.messages || [];
    console.log(`\r${c.green}✅ [조회 완료]${c.reset} ${c.bold}${chat.title || chat.id}${c.reset} (${msgs.length}개 메시지)\n`);
    console.log(`${c.gray}${'─'.repeat(70)}${c.reset}`);
    for (const m of msgs) {
      const timeStr = formatTime(m.sendAt);
      const isMe = String(m.authorId) === String(state.userId);
      const sender = isMe ? `${c.yellow}[나]${c.reset}` : `${c.cyan}[${m.authorName || (res.members && res.members[m.authorId]?.name) || m.authorId || '상대방'}]${c.reset}`;
      const media = messageAttachments(m);
      const body = m.text && !(media.length && String(m.text).trim().startsWith('{')) ? m.text : c.dim + '(미디어/첨부)' + c.reset;
      console.log(` ${c.dim}${timeStr}${c.reset}  ${sender}  ${body}`);
      for (const a of media) {
        console.log(`        ${c.gray}📎 ${mediaTypeName(a.type)}: kakao download ${chat.id} ${a.token} <저장경로> --message-id ${m.messageId} --type ${mediaTypeName(a.type)}${c.reset}`);
      }
    }
    console.log(`${c.gray}${'─'.repeat(70)}${c.reset}`);
    const s = res.sync;
    if (s) {
      const why = s.error ? ` error=${s.error}` : s.reason ? ` (${s.reason})` : '';
      console.log(`${c.dim}SYNCMSG ${s.mode}: status=${s.status ?? '-'} pages=${s.pages} fetched=${s.fetched} new=${s.inserted} max=${s.max}${why}${c.reset}`);
    }
    console.log('');
  } catch (e: any) {
    process.exitCode = 1;
    if (e.code === 'APPROVAL_REQUIRED') reportWriteError(e, requestId);
    else console.log(`\r${c.red}❌ [조회 실패]${c.reset} ${e.message}\n`);
  }
}

// read_messages searches one room at a time; there is no account-wide search.
async function cmdSearch(query: string, targetArg?: string, readGrantId?: string, requestId: string = randomUUID()) {
  if (!query || !targetArg) {
    console.error(`\n${c.red}❌ 사용법: kakao search "<검색어>" <대화방>${c.reset} ${c.gray}(검색은 한 방씩만 가능합니다)${c.reset}\n`);
    process.exit(1);
  }
  const backend = await getBackend();
  const state = await backend.getState();
  const chat = resolveRoom(state.chats, targetArg);
  if (!chat) {
    console.error(`\n${c.red}❌ 대화방을 찾을 수 없습니다: "${targetArg}"${c.reset}\n`);
    process.exit(1);
  }
  const chatId = chat.id;

  process.stdout.write(`${c.dim}[검색 중...]${c.reset} "${query}" 메시지 검색 중... `);
  try {
    const res = await backend.searchMessages(query, chatId, 20, readGrantId, requestId);
    const msgs = res.messages || [];
    console.log(`\r${c.green}✅ [검색 완료]${c.reset} "${c.bold}${query}${c.reset}" 결과: ${msgs.length}건\n`);
    for (const m of msgs) {
      const chatTitle = state.chats.find(c => c.id === m.chatId)?.title || m.chatId;
      const timeStr = formatTime(m.sendAt);
      console.log(` ${c.magenta}[${truncate(chatTitle, 15)}]${c.reset} ${c.dim}${timeStr}${c.reset} ${c.bold}${m.authorName || '상대방'}:${c.reset} ${m.text}`);
    }
    console.log('');
  } catch (e: any) {
    process.exitCode = 1;
    if (e.code === 'APPROVAL_REQUIRED') reportWriteError(e, requestId);
    else console.log(`\r${c.red}❌ [검색 실패]${c.reset} ${e.message}\n`);
  }
}

/** A command from commands.ts: one daemon tool, its JSON result printed as is. */
async function cmdTool(name: string, argv: string[]) {
  const { command, args, values, requestId = randomUUID() } = parseCommand(name, argv);
  const mcp = new McpClient({ host: MCP_HOST, port: MCP_PORT });
  try { await mcp.connect(); }
  catch (e) {
    console.error(`${c.red}❌ 카카오톡 MCP 데몬(${MCP_HOST}:${MCP_PORT})에 연결할 수 없습니다.${c.reset} ${c.dim}${(e as Error).message}${c.reset}`);
    process.exit(1);
  }
  const cli: CliContext = {
    requestId,
    call: (tool, toolArgs = {}) => mcp.callTool(tool, toolArgs),
    write: (tool, toolArgs, kind) => submitWrite(mcp, tool, { ...toolArgs, requestId }, kind),
    async room(target) {
      const chat = resolveRoom((await mcp.callTool('list_chats')).chats || [], target);
      if (!chat) throw new KakaoError('NOT_FOUND', `대화방을 찾을 수 없습니다: "${target}" ('kakao ls' 또는 'kakao find-room' 으로 확인)`);
      return chat.id;
    }
  };
  try {
    console.log(JSON.stringify(await command.run(cli, args, values), null, 2));
  } catch (e: any) {
    process.exitCode = 1;
    if (['APPROVAL_REQUIRED', 'SEND_OUTCOME_UNKNOWN', 'MUTATION_OUTCOME_UNKNOWN'].includes(e.code)) reportWriteError(e, requestId);
    else if (command.group && /^unknown tool:/.test(e.message)) {
      // A tool in a group the daemon did not enable is not listed at all.
      console.log(`${c.red}❌ ${e.message}${c.reset}`);
      console.log(`${c.gray}이 명령은 데몬의 '${command.group}' 도구 묶음이 필요합니다 (KAKAO_MCP_TOOL_GROUPS).${c.reset}`);
    } else console.log(`${c.red}❌ [${e.code ?? '오류'}]${c.reset} ${e.message}`);
  } finally { mcp.close(); }
}

// Read-only smoke test against the live MCP daemon. Never sends, restores, or writes;
// every check asserts on real data and the process exits non-zero on any failure.
async function cmdTest(groupOnly = false, chatId?: string) {
  class SmokeAssertionError extends Error {}
  console.log(`\n${c.bold}🧪 kakao-max 스모크 테스트 (읽기 전용, MCP 데몬 직접 연결)${c.reset}\n`);
  const backend = await getBackend();
  const readRoom = readRoomSmokeAccess(backend);
  let failed = 0;
  let n = 0;
  const check = async (name: string, fn: () => Promise<string>) => {
    n++;
    process.stdout.write(` ${n}. ${name} ... `);
    try {
      console.log(`${c.green}✔ PASS${c.reset} ${c.dim}${await fn()}${c.reset}`);
    } catch (e: any) {
      failed++;
      console.log(`${c.red}✖ FAIL${c.reset} ${e instanceof SmokeAssertionError ? e.message : toKakaoError(e).code}`);
    }
  };
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new SmokeAssertionError(msg);
  };

  let state: ServerState = { connected: false, chats: [] };
  await check('get_status: LOCO 세션 연결', async () => {
    state = await backend.getState();
    assert(state.connected, 'connected=false');
    assert(state.userId, 'userId 없음');
    return '계정 연결 확인';
  });

  await check('list_chats: 방 목록과 1:1/그룹 구분', async () => {
    assert(state.chats.length > 0, '대화방 0개');
    const bad = state.chats.filter((ch) => !ch.id || !ch.type);
    assert(bad.length === 0, `id/type 없는 방 ${bad.length}개`);
    const misclassified = state.chats.filter((ch) => ch.type === 'DirectChat' && (ch.memberCount ?? 2) > 2);
    assert(misclassified.length === 0, `memberCount>2 인 DirectChat ${misclassified.length}개`);
    const direct = state.chats.filter((ch) => ch.type === 'DirectChat').length;
    return `${state.chats.length}개 (1:1 ${direct}, 기타 ${state.chats.length - direct})`;
  });

  await check('list_friends: 주소록 로드 및 이름 검색', async () => {
    const all = await backend.listFriends('', 5);
    assert(all.count > 0 && all.friends.length > 0, '친구 0명');
    const f = all.friends[0];
    assert(f.userId, '첫 친구에 userId 없음');
    const name = f.friendNickName || f.nickName;
    const hit = await backend.listFriends(name, 50);
    assert(hit.friends.some((x: any) => String(x.userId) === String(f.userId)), '친구 이름 검색 결과에 대상이 없음');
    return '주소록 및 이름 검색 확인';
  });

  async function expectPolicyDenied(fn: () => Promise<unknown>) {
    try { await fn(); }
    catch (error) {
      if (error instanceof McpToolError && error.code === 'POLICY_DENIED') return;
      throw error;
    }
    throw new Error('Expected POLICY_DENIED but content access succeeded');
  }
  // A deny room asks the person when read without a grant. Probing with a grant ID that cannot exist skips
  // that prompt and must still be refused, so the smoke never leaves an approval request behind.
  const noGrant = `smoke-no-grant-${randomUUID()}`;
  let denyMode = false;
  let sample: any;
  let sampleChatId: string | undefined;
  await check('read_messages: 허용 방 내용 또는 명시적 접근 차단', async () => {
    const recent = [...state.chats].filter((ch) => ch.unreadCount === 0 && (!chatId || ch.id === chatId) &&
      (ch.lastSendAt || chatId) && (!groupOnly || !isDirectChat(ch))).sort((x, y) => (y.lastSendAt ?? 0) - (x.lastSendAt ?? 0))[0];
    assert(recent, '명시적으로 읽은 상태인 스모크 대상 방이 없음');
    sampleChatId = recent.id;
    const access = await backend.getRoomAccess(recent.id);
    denyMode = access.rule.mode === 'deny';
    if (denyMode) {
      await expectPolicyDenied(() => backend.getHistory(recent.id, 1, noGrant));
      return 'deny 정책으로 내용 조회 차단 확인';
    }
    const hist = await readRoom.history(recent.id, 20);
    assert((hist as any).untrusted === true, 'read_messages 결과에 untrusted 표시 없음 (prompt-injection 가드)');
    const msgs = hist.messages || [];
    assert(msgs.length > 0, '허용 방 메시지 0건');
    const wrongChat = msgs.filter((m: any) => m.chatId != null && String(m.chatId) !== String(recent.id));
    assert(wrongChat.length === 0, `다른 방 메시지 ${wrongChat.length}건 섞임`);
    const times = new Set(msgs.map((m: any) => m.sendAt));
    assert(msgs.length < 3 || times.size > 1, '모든 메시지 시간이 동일');
    sample = msgs.find((m: any) => typeof m.text === 'string' && /\S{2,}/.test(m.text) && !m.text.trim().startsWith('{'));
    return `허용 방 ${msgs.length}건`;
  });

  await check('search_messages: 허용 방 검색 또는 명시적 접근 차단', async () => {
    const deniedChatId = sampleChatId;
    if (denyMode && deniedChatId) {
      await expectPolicyDenied(() => backend.searchMessages('policy-smoke', deniedChatId, 1, noGrant));
      return 'deny 정책으로 검색 차단 확인';
    }
    assert(sample && sampleChatId, '읽은 방의 검색용 텍스트 메시지가 없음');
    const word = sample.text.split(/\s+/).find((w: string) => w.length >= 2) as string;
    const res = await readRoom.search(word, sampleChatId!, 20);
    assert(res.count > 0, '허용 방 검색 결과 0건');
    return `허용 방 검색 ${res.count}건`;
  });

  await check('내용 보호: 허용 방 데이터 또는 미리보기 차단', async () => {
    if (denyMode) {
      const fresh = await backend.getState();
      assert(fresh.chats.every(chat => !chat.lastMessage), '정책 밖 미리보기 노출');
      return '메타데이터만 노출, 대화 내용 검사 없음';
    }
    assert(sampleChatId, '검사할 읽은 방이 없음');
    return '허용 방 열람';
  });

  if (failed > 0) {
    console.log(`\n${c.red}${c.bold}✖ ${failed}/${n} 실패${c.reset}\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n${c.green}${c.bold}✔ ${n}/${n} 통과${c.reset}\n`);
  }
}

const paint: Paint = { bold: s => c.bold + s + c.reset, cyan: s => c.cyan + s + c.reset, gray: s => c.gray + s + c.reset, yellow: s => c.yellow + s + c.reset };

/** Overview of every command, or one command's usage when a name is given. */
function cmdHelp(topic?: string): boolean {
  if (!topic) {
    console.log('\n' + renderOverview(paint) + '\n');
    return true;
  }
  const page = renderCommand(topic, paint);
  if (page) console.log('\n' + page + '\n');
  else unknownCommand(topic);
  return page !== undefined;
}

function unknownCommand(name: string): void {
  const near = suggest(name);
  console.error(`${c.red}알 수 없는 명령어: ${name}${c.reset}`);
  if (near.length) console.error(`혹시: ${near.map(n => c.cyan + 'kakao ' + n + c.reset).join(', ')}`);
  console.error(`${c.gray}전체 명령어: kakao help${c.reset}`);
}

/** `kakao setup|web|approver ...`: run that program of this install in the same terminal. */
function runProgram(name: 'setup' | 'web' | 'approver', args: string[]): number {
  const result = spawnSync(process.execPath, [...programArgs(name), ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

// ----------------------------------------------------------------------------
// Entrypoint
// ----------------------------------------------------------------------------

async function main() {
  const [,, cmd, ...args] = process.argv;
  const option = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

  // `<명령어> --help` shows that command's usage and never runs it (a send stays unsent).
  if (cmd && !['help', 'commands', '--help', '-h'].includes(cmd) && (args.includes('--help') || args.includes('-h'))) {
    if (!cmdHelp(cmd)) process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case 'chat':
      await runTerminalMessenger(args, { host: MCP_HOST, port: MCP_PORT });
      break;
    case 'shell':
      await runChatShell(args, { host: MCP_HOST, port: MCP_PORT });
      break;
    case 'ls':
    case 'list':
      await cmdList();
      break;
    case 'friends':
    case 'contacts':
      await cmdFriends(args[0]);
      break;
    case 'hist':
    case 'history':
      await cmdHistory(args[0], args[1]?.startsWith('--') ? undefined : args[1], option('--read-grant'), option('--request-id'));
      break;
    case 'search':
    case 'find':
      await cmdSearch(args[0], args[1]?.startsWith('--') ? undefined : args[1], option('--read-grant'), option('--request-id'));
      break;
    case 'test':
    case 'smoke':
      await cmdTest(args.includes('--group-only'), args.includes('--chat-id') ? args[args.indexOf('--chat-id') + 1] : undefined);
      break;
    case 'submit': {
      // Run once to ask the person; run again with the same file after they approve.
      if (!args[0]) throw new Error('Usage: kakao submit <owner-only-request.json>');
      const client = new McpClient({ host: MCP_HOST, port: MCP_PORT });
      try {
        await client.connect();
        console.log(JSON.stringify(await runAgentFileCommand(client, args[0]), null, 2));
      } catch (e: any) {
        process.exitCode = 1;
        reportWriteError(e, readAgentRequest(args[0]).requestId);
      } finally { client.close(); }
      break;
    }
    case 'send': {
      const id = option('--request-id');
      const words = args.slice(1).filter((a, i, all) => a !== '--request-id' && all[i - 1] !== '--request-id');
      await cmdSend(args[0], words.join(' '), id);
      break;
    }
    case 'send-photo':
    case 'photo':
      await cmdSendMedia(args[0], args[1], 2, option('--request-id'));
      break;
    case 'send-file':
    case 'file':
      await cmdSendMedia(args[0], args[1], 18, option('--request-id'));
      break;
    case 'download':
    case 'download-media':
    case 'dl':
      await cmdDownloadMedia(args[0], args[1], args[2], parseMediaType(option('--type')), args.includes('--mini'), option('--message-id'), option('--read-grant'));
      break;
    case 'read':
      await cmdRead(args[0], option('--request-id'));
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'setup':
    case 'web':
    case 'approver':
      process.exitCode = runProgram(cmd, args);
      break;
    case 'help':
    case 'commands':
    case '--help':
    case '-h':
      if (!cmdHelp(args[0])) process.exitCode = 1;
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(JSON.parse(fs.readFileSync(path.join(installRoot(), 'package.json'), 'utf8')).version);
      break;
    default:
      if (!cmd) {
        // Default to ls if no command given
        await cmdList();
      } else if (Object.hasOwn(COMMANDS, cmd)) {
        await cmdTool(cmd, args);
      } else {
        unknownCommand(cmd);
        process.exit(1);
      }
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(`${c.red}오류 발생: ${err.message}${c.reset}`);
    process.exit(1);
  });

