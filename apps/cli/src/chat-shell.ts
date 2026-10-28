import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { McpClient, McpToolError, type ElicitationReply } from './mcp-client.ts';
import { sendMessage } from './agent-send-client.ts';

interface Room { id: string; title?: string; type?: string; memberCount?: number; unreadCount?: number | null; }
interface Message { seq?: number; type?: number; logId?: string; messageId?: string; authorId?: string; authorName?: string; text?: string; sendAt?: number; }
interface History { messages: Message[]; sync?: { error?: unknown; status?: number; }; }
export interface ShellClient { callTool<T = any>(name: string, args?: Record<string, unknown>): Promise<T>; }
export interface ShellOptions { demo?: boolean; showRoom?: string; }

/** Titles, names and messages are data, never terminal escape sequences or commands. */
export function shellText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      c => c === '\n' || c === '\r' ? ' ↵ ' : `⟦${c.codePointAt(0)!.toString(16)}⟧`);
}
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
const unquote = (s: string) => /^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s;
class ShellInputError extends Error {}
const COMMANDS = ['ls', 'cd', 'pwd', 'history', 'older', 'pending', 'help', 'clear', 'exit'];
const HELP = 'ls [-al] 목록 · cd <방 이름/번호> 입장 · cd .. 돌아가기 · history [1~100] 최근 대화 · older 이전 대화 · /send <내용> 전송 · pending 전송 상태 · clear · exit';

export class ChatShell {
  private readonly client: ShellClient;
  private readonly write: (line: string, kind?: 'message') => void;
  private readonly options: ShellOptions;
  private rooms: Room[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly authors = new Map<string, string>();
  private current?: Room;
  private userId?: string;
  private publicRoomId?: string;
  private oldest?: string;
  private readonly shownMessages = new Set<string>();
  private historyLimit = 30;
  private recentCursor = 0;
  private liveAfter = 0n;
  private pendingSend?: { chatId: string; text: string; requestId: string };

  constructor(client: ShellClient, write: (line: string, kind?: 'message') => void, options: ShellOptions = {}) {
    this.client = client; this.write = write; this.options = options;
    if (options.demo && !options.showRoom?.trim()) throw new ShellInputError('촬영 모드에는 --show-room으로 공개할 방을 지정하세요.');
  }

  async start(): Promise<void> {
    const status = await this.client.callTool('get_status');
    if (!status.connected) throw new ShellInputError('데몬의 카카오톡 연결이 끊겨 있습니다.');
    this.userId = status.userId;
    await this.refresh();
    this.write('kakao-max shell · ' + (this.options.demo ? '촬영 모드' : '대화형 모드'));
    if (this.options.demo) this.write('다른 방 이름·발신자는 가명으로 표시합니다. 공개 방의 메시지 본문은 그대로 표시됩니다.');
    this.write('ls -al → cd <방 이름> (Tab 자동완성) → 메시지 입력 후 Enter');
    this.write('방 안의 일반 입력은 전송됩니다. 명령은 /help로 확인하세요. 읽음 표시는 보내지 않습니다.');
  }

  get prompt(): string { return this.current ? `kakao:/${this.label(this.current)} > ` : 'kakao:/ > '; }

  get currentTitle(): string | undefined { return this.current && this.label(this.current); }
  get choices(): { index: number; label: string; unread: number | null; openable: boolean }[] {
    return this.rooms.map((r, i) => ({ index: i + 1, label: this.label(r), unread: r.unreadCount ?? null,
      openable: !this.options.demo || r.id === this.publicRoomId }));
  }

  /** Poll only the selected room's authorized live feed, without a receipt or another account session. */
  async receive(): Promise<void> {
    if (!this.current) return;
    const out = await this.client.callTool<{ messages: Message[]; cursor: number }>('read_messages', {
      chatId: this.current.id, mode: 'recent', sinceSeq: this.recentCursor
    });
    for (const m of out.messages ?? []) {
      const id = messageId(m);
      if (this.shownMessages.has(id) || (/^\d+$/.test(id) && BigInt(id) <= this.liveAfter)) continue;
      this.printMessage(m);
    }
    this.recentCursor = out.cursor;
  }

  private label(room: Room): string {
    if (this.options.demo && room.id !== this.publicRoomId) return this.aliases.get(room.id)!;
    return shellText(room.title || this.aliases.get(room.id));
  }

  private async refresh(): Promise<void> {
    const out = await this.client.callTool('list_chats');
    const rooms: Room[] = out.chats ?? [];
    for (const room of rooms) if (!this.aliases.has(room.id)) this.aliases.set(room.id, `대화방 ${String(this.aliases.size + 1).padStart(3, '0')}`);
    if (this.options.demo) {
      const matches = rooms.filter(r => normalize(r.title ?? '') === normalize(this.options.showRoom!));
      if (matches.length !== 1) throw new ShellInputError('공개할 방 이름이 없거나 중복됩니다. 이름을 확인하고 다시 시작하세요.');
      // Once selected, a different room with the same title must never inherit public status.
      if (this.publicRoomId !== undefined && this.publicRoomId !== matches[0].id) throw new ShellInputError('공개할 방이 변경되었습니다. 다시 시작하세요.');
      this.publicRoomId = matches[0].id;
    }
    this.rooms = rooms;
  }

  complete(line: string): [string[], string] {
    if (/^\/?cd\s+/.test(line)) {
      const prefix = line.slice(0, line.search(/\s/) + 1);
      const query = line.slice(prefix.length);
      // Completion operates on displayed labels only; never real names hidden by demo mode.
      const names = this.rooms.filter(r => !this.options.demo || r.id === this.publicRoomId).map(r => this.label(r));
      return [names.filter(n => normalize(n).startsWith(normalize(unquote(query)))).map(n => prefix + n), line];
    }
    if (this.current && !line.startsWith('/')) return [[], line];
    const slash = line.startsWith('/') ? '/' : '';
    return [COMMANDS.map(c => slash + c).filter(c => c.startsWith(line)), line];
  }

  async execute(raw: string): Promise<boolean> {
    const line = raw.trim();
    if (!line) return true;
    const match = /^(\/?[^\s]+)(?:\s+([\s\S]*))?$/.exec(line)!;
    const command = match[1].replace(/^\//, '');
    const arg = (match[2] ?? '').trim();
    try {
      if (command === 'exit' || command === 'quit') return false;
      if (command === 'help') { this.write(HELP); return true; }
      if (command === 'clear') { this.write('\x1b[2J\x1b[H'); return true; }
      if (command === 'pwd') { this.write(this.current ? '/' + this.label(this.current) : '/'); return true; }
      if (command === 'ls') {
        if (arg && !['-al', '-la', '-a', '-l'].includes(arg)) throw new ShellInputError('사용법: ls [-al]');
        await this.refresh();
        this.write(`대화방 ${this.rooms.length}개 (현재 데몬에 로드된 목록)`);
        this.write(arg.includes('l') ? '번호  구분    인원  안읽음  대화방' : '번호  대화방');
        this.rooms.forEach((room, i) => {
          const detail = arg.includes('l') ? `${room.type === 'MemoChat' ? '메모' : room.type === 'OM' ? '오픈' : '대화'}  ${room.memberCount ?? '-'}  ${room.unreadCount ?? '-'}  ` : '';
          this.write(`${String(i + 1).padStart(2)}  ${detail}${this.label(room)}`);
        });
        return true;
      }
      if (command === 'cd') {
        // A failed room switch must not leave the old recipient selected for the next typed line.
        this.current = undefined; this.oldest = undefined; this.shownMessages.clear(); this.recentCursor = 0; this.liveAfter = 0n;
        if (!arg || arg === '..' || arg === '/') return true;
        await this.refresh();
        const query = unquote(arg);
        const numbered = /^#?[1-9]\d*$/.test(query) ? this.rooms[Number(query.replace('#', '')) - 1] : undefined;
        const exact = this.rooms.filter(r => normalize(this.label(r)) === normalize(query));
        const matches = numbered ? [numbered] : exact.length ? exact : this.rooms.filter(r => normalize(this.label(r)).includes(normalize(query)));
        if (matches.length !== 1) throw new ShellInputError(matches.length ? '같은 이름의 방이 여러 개입니다. ls의 번호로 선택하세요.' : '방을 찾지 못했습니다. ls로 목록을 확인하세요.');
        const room = matches[0];
        if (this.options.demo && room.id !== this.publicRoomId) throw new ShellInputError('촬영 모드에서는 공개 대상으로 지정한 방만 열 수 있습니다.');
        await this.history(room, 30);
        this.current = room;
        return true;
      }
      if (command === 'history' || command === 'older') {
        if (!this.current) throw new ShellInputError('먼저 cd로 방을 선택하세요.');
        if (command === 'older' && arg) throw new ShellInputError('사용법: older');
        const limit = command === 'older' ? this.historyLimit : arg ? Number(arg) : 30;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ShellInputError('조회 개수는 1~100 사이로 입력하세요.');
        if (command === 'older' && !this.oldest) { this.write('이전에 조회한 메시지가 없습니다. history로 먼저 조회하세요.'); return true; }
        await this.history(this.current, limit, command === 'older');
        return true;
      }
      if (command === 'pending') {
        if (!this.pendingSend) { this.write('확인할 전송 요청이 없습니다.'); return true; }
        const result = await this.client.callTool('get_operation', { requestId: this.pendingSend.requestId });
        this.write(`기존 요청 상태: ${shellText(result.state ?? result.operation?.state ?? '미확인')} (재전송하지 않음)`);
        return true;
      }
      if (!this.current) throw new ShellInputError('먼저 ls로 목록을 보고 cd로 방을 선택하세요.');
      if (line.startsWith('/') && command !== 'send') throw new ShellInputError('알 수 없는 명령입니다. /help로 확인하세요.');
      const text = command === 'send' && line.startsWith('/') ? arg : raw;
      if (!text.trim()) throw new ShellInputError('보낼 메시지를 입력하세요.');
      // No silent retries, including another Enter after a timeout or an approval-required result.
      if (this.pendingSend) throw new ShellInputError('앞선 전송을 확인해야 합니다. /pending으로 조회하고 필요하면 셸을 종료해 확인하세요. 자동 재전송하지 않습니다.');
      const request = { chatId: this.current.id, text, requestId: randomUUID() };
      this.pendingSend = request;
      try {
        const sent = await sendMessage(this.client, { chatId: request.chatId, text }, request.requestId);
        this.printMessage({ messageId: sent.logId, authorId: this.userId, text, type: 1, sendAt: Date.now() / 1000 });
        this.pendingSend = undefined;
        this.write('✓ 전송 요청 처리 완료 · 실제 도착은 카톡에서도 확인하세요.');
      } catch (e) {
        if (e instanceof McpToolError && e.code !== 'APPROVAL_REQUIRED') this.pendingSend = undefined;
        throw e;
      }
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === 'string' ? String((e as { code: string }).code) : '';
      if (this.options.demo && !(e instanceof ShellInputError)) this.write(`오류: ${shellText(code || '요청 처리 실패')} · 촬영 전에 일반 모드에서 권한·연결 상태를 확인하세요.`);
      else this.write(`오류: ${shellText((e as Error).message)}`);
    }
    return true;
  }

  private printMessage(m: Message): void {
    const authorId = m.authorId ?? m.authorName ?? 'unknown';
    const mine = m.authorId !== undefined && m.authorId === this.userId;
    if (!mine && !this.authors.has(authorId)) this.authors.set(authorId, `참여자 ${this.authors.size + 1}`);
    const author = mine ? '나' : this.options.demo ? this.authors.get(authorId)! : shellText(m.authorName || this.authors.get(authorId));
    const time = Number.isFinite(m.sendAt) ? new Date(m.sendAt! * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
    this.write(`${time}  ${author}  ${messageText(m)}`, 'message');
    this.shownMessages.add(messageId(m));
    while (this.shownMessages.size > 2000) this.shownMessages.delete(this.shownMessages.values().next().value!);
  }

  private async history(room: Room, limit: number, older = false): Promise<void> {
    const out = await this.client.callTool<History>('read_messages', { chatId: room.id, limit, ...(older ? { beforeLogId: this.oldest } : {}) });
    if (out.sync?.error || (out.sync?.status !== undefined && ![0, -203].includes(out.sync.status))) throw new ShellInputError('대화 동기화가 완료되지 않았습니다. 다시 확인하세요.');
    const all = [...(out.messages ?? [])].sort((a, b) => (a.sendAt ?? 0) - (b.sendAt ?? 0) || compareIds(a, b));
    const messages = older ? all.filter(m => !this.shownMessages.has(messageId(m))) : all;
    if (!older) this.shownMessages.clear();
    this.write(`── ${this.label(room)} · ${older ? '이전' : '최근'} 대화 ${messages.length}개 ──`);
    for (const m of messages) this.printMessage(m);
    // Provider upper bounds can be inclusive. Move below the oldest returned ID and deduplicate defensively.
    const ids = all.map(messageId).filter(id => /^[1-9]\d*$/.test(id)).map(BigInt);
    if (!older || messages.length) {
      this.oldest = ids.length ? (ids.reduce((a, b) => a < b ? a : b) - 1n).toString() : undefined;
    }
    if (!older) this.liveAfter = ids.length ? ids.reduce((a, b) => a > b ? a : b) : 0n;
    this.historyLimit = limit;
    if (!messages.length) this.write('조회 가능한 대화가 없습니다.');
    this.write('이 기기에서 조회 가능한 기록입니다. 오래된 대화 전체가 포함된다고 보장하지 않습니다.');
  }
}
function messageText(m: Message): string {
  // System feeds can embed member IDs and nicknames in JSON, even when names in the author column are hidden.
  if (m.type === 0) return '(대화방 알림)';
  if (m.type !== undefined && m.type !== 1) return '(첨부 메시지)';
  try {
    const body = JSON.parse(m.text ?? '');
    if (body && typeof body === 'object' && 'feedType' in body) return '(대화방 알림)';
  } catch { /* ordinary message text */ }
  return shellText(m.text || '(첨부 메시지)');
}
function messageId(m: Message): string { return String(m.logId ?? m.messageId ?? ''); }
function compareIds(a: Message, b: Message): number {
  const x = messageId(a), y = messageId(b);
  return /^\d+$/.test(x) && /^\d+$/.test(y) ? BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0 : 0;
}

export async function runChatShell(args: string[], endpoint: { host: string; port: number }): Promise<void> {
  let demo = false, showRoom: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo') demo = true;
    else if (args[i] === '--show-room' && args[i + 1] && !args[i + 1].startsWith('--')) showRoom = args[++i];
    else throw new ShellInputError('사용법: kakao shell [--demo --show-room "공개할 방 이름"]');
  }
  if (showRoom && !demo) throw new ShellInputError('--show-room은 --demo와 함께 사용하세요.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ShellInputError('대화형 터미널에서 실행하세요. 원격 접속은 ssh -t를 사용하세요.');
  let shell: ChatShell;
  const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 0,
    completer: (line: string): [string[], string] => shell?.complete(line) ?? [[], line] });
  let stopped = false;
  rl.on('close', () => { stopped = true; });
  rl.on('SIGINT', () => rl.close());
  const ask = async (prompt: string) => stopped ? '' : rl.question(prompt);
  const client = new McpClient({ host: endpoint.host, port: endpoint.port, timeoutMs: 150000,
    ...(!demo ? { onElicitation: async (params: Record<string, any>): Promise<ElicitationReply> => {
      if ((params.mode !== undefined && params.mode !== 'form') || !params.requestedSchema?.properties?.code) return { action: 'cancel' };
      console.log('\n' + String(params.message ?? '').split('\n').map(shellText).join('\n'));
      const typed = (await ask('승인 코드 입력 (빈 입력은 거절): ')).trim();
      if (!typed || stopped) return { action: 'decline' };
      // The code is entered by the person; never extract or answer it from the server's text.
      const remember = params.requestedSchema?.properties?.remember;
      const keep = remember && !stopped ? (await ask(`${shellText(remember.title)}? [y/N] `)).trim().toLowerCase() === 'y' : false;
      return stopped ? { action: 'cancel' } : { action: 'accept', content: { code: typed, remember: keep } };
    } } : {})
  });
  rl.on('close', () => client.close());
  try {
    await client.connect();
    shell = new ChatShell(client, line => console.log(line), { demo, showRoom });
    await shell.start();
    while (!stopped) {
      let line: string;
      try { line = await rl.question(shell.prompt); } catch { break; }
      if (!await shell.execute(line)) break;
    }
  } catch (e) {
    if (demo && !(e instanceof ShellInputError)) throw new ShellInputError('촬영 모드 연결 실패. 촬영 전에 일반 모드에서 연결 상태를 확인하세요.');
    throw e;
  } finally { rl.close(); client.close(); }
}
