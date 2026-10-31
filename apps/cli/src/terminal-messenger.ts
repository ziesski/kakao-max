import { emitKeypressEvents, type Key } from 'node:readline';
import { terminalText as shellText, type DisplayOptions } from './terminal-text.ts';
import { Conversation, McpConversationReader, type ConversationReader, type WriteResult, type MessageWriter } from '@kakao-max/client';
import { ConversationView } from './conversation-view.ts';
import { conversationError } from './conversation-errors.ts';
import { sendMessage } from './agent-send-client.ts';
import { McpToolError } from './mcp-client.ts';
import { McpClient, type ElicitationReply } from './mcp-client.ts';

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const graphemes = (s: string) => [...segmenter.segment(s)].map(v => v.segment);
function cellWidth(s: string): number {
  const n = s.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}/u.test(s) || n >= 0x1f1e6 && n <= 0x1f1ff ||
    n >= 0x1100 && (n <= 0x115f || n >= 0x2329 && n <= 0x232a || n >= 0x2e80 && n <= 0xa4cf ||
      n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f ||
      n >= 0xff01 && n <= 0xff60 || n >= 0xffe0 && n <= 0xffe6 || n >= 0x20000) ? 2 : /^\p{Mark}+$/u.test(s) ? 0 : 1;
}
export const terminalWidth = (s: string): number => graphemes(s).reduce((n, g) => n + cellWidth(g), 0);
function fit(s: string, width: number): string {
  let out = '', used = 0;
  for (const g of graphemes(shellText(s))) { const size = cellWidth(g); if (used + size > width) break; out += g; used += size; }
  return out + ' '.repeat(Math.max(0, width - used));
}
function wrap(s: string, width: number): string[] {
  const lines: string[] = []; let line = '', used = 0;
  for (const g of graphemes(shellText(s))) {
    const size = cellWidth(g);
    if (used + size > width) { lines.push(line); line = ''; used = 0; }
    line += g; used += size;
  }
  lines.push(line); return lines;
}
interface Field { text: string; cursor: number; }
interface Approval {
  params: Record<string, any>; text: string; scroll: number; phase: 'code' | 'remember'; code?: string;
  resolve: (value: ElicitationReply) => void;
}

/** Keyboard and terminal rendering only; the shared conversation owns account-independent state. */
export class TerminalMessenger {
  readonly conversation: Conversation;
  private readonly presentation: ConversationView;
  readonly options: DisplayOptions;
  focus: 'rooms' | 'chat' = 'rooms';
  search: Field = { text: '', cursor: 0 };
  draft: Field = { text: '', cursor: 0 };
  selected = 0;
  scroll = 0;
  status = '연결 중…';
  busy = false;
  polling = true;
  closed = false;
  private approval?: Approval;
  private paste?: string;
  private sending = false;
  private readOnce = false;
  private resumeReads = false;
  private revision = 0;
  private readonly redraw: () => void;

  constructor(reader: ConversationReader, writer: MessageWriter, options: DisplayOptions, redraw: () => void) {
    this.options = options; this.redraw = redraw; this.presentation = new ConversationView(options);
    this.conversation = new Conversation(reader, writer, () => {
      this.revision++;
      if (this.conversation.readError && !this.busy) { this.status = conversationError(this.conversation.readError, this.options.demo); this.polling = false; }
      if (!this.busy && !this.closed) this.redraw();
    }, room => this.presentation.canOpen(room), () => !this.readOnce);
  }
  get filtered() {
    return this.conversation.rooms.map(r => ({ id: r.id, label: this.presentation.label(r), unread: r.unreadCount, openable: this.presentation.canOpen(r) }))
      .filter(r => r.label.normalize('NFKC').toLocaleLowerCase().includes(this.search.text.normalize('NFKC').toLocaleLowerCase()));
  }
  private get currentTitle(): string | undefined { return this.conversation.active && this.presentation.label(this.conversation.active); }
  async start(): Promise<void> {
    await this.work(async () => { await this.conversation.start(); this.presentation.update(this.conversation.rooms); this.status = '방 이름을 검색하거나 방향키로 선택하세요.'; });
  }
  connectionLost(error: Error): void {
    const code = (this.conversation.readError as { code?: string })?.code ?? '';
    this.resumeReads = !this.readOnce && (this.polling && this.conversation.live || this.resumeReads && ['NETWORK', 'TIMEOUT', 'NOT_CONNECTED'].includes(code));
    this.approval?.resolve({ action: 'cancel' }); this.approval = undefined;
    this.conversation.disconnected(error); this.status = '연결 끊김 · 재연결 중… · 전송은 자동 재시도하지 않습니다.'; this.redraw();
  }
  async reconnected(): Promise<void> {
    await this.work(async () => {
      await this.conversation.start(); this.presentation.update(this.conversation.rooms);
      if (this.resumeReads) await this.conversation.refresh();
      this.polling = this.resumeReads && this.conversation.live;
      this.status = this.polling ? '재연결됨 · 최근 대화 재조회 · 이벤트 수신 중' : '재연결됨 · 자동 갱신 중지 · Ctrl+R로 직접 재조회';
      if (this.readOnce) this.pauseAfterOneRead();
    });
  }
  private async work(job: () => Promise<void>, quiet = false): Promise<void> {
    if (this.busy || this.closed) return;
    const before = this.revision, previousStatus = this.status;
    this.busy = true; if (!quiet) this.redraw();
    try { await job(); } catch (e) { this.status = conversationError(e, this.options.demo); this.polling = false; }
    finally { this.busy = false; if (!this.closed && (!quiet || before !== this.revision || previousStatus !== this.status)) this.redraw(); }
  }
  async poll(): Promise<void> {
    if (!this.currentTitle || !this.polling) return;
    await this.work(async () => {
      await this.conversation.poll();
      if (this.readOnce) this.pauseAfterOneRead();
    }, true);
  }

  private pauseAfterOneRead(): void {
    this.resumeReads = false; this.conversation.stopUpdates();
    this.polling = false; this.status = '이번 조회만 허용했습니다. 자동 갱신 중지 · Ctrl+R로 다시 조회';
  }

  /** Only the person's keystrokes answer this form; no code is extracted from its message. */
  askApproval(params: Record<string, any>): Promise<ElicitationReply> {
    if (this.closed || this.options.demo || this.approval || (params.mode !== undefined && params.mode !== 'form') || !params.requestedSchema?.properties?.code) return Promise.resolve({ action: 'cancel' });
    return new Promise(resolve => {
      this.approval = { params, text: '', scroll: 0, phase: 'code', resolve }; this.redraw();
    });
  }
  close(): void {
    this.closed = true; this.conversation.close();
    this.approval?.resolve({ action: 'cancel' }); this.approval = undefined;
    this.draft = { text: '', cursor: 0 }; this.paste = undefined;
  }

  async key(text: string, key: Key = {}): Promise<void> {
    if (this.closed) return;
    if (key.name === 'paste-start') { this.paste = ''; return; }
    if (this.paste !== undefined) {
      if (key.name === 'paste-end') {
        const value = this.paste.replace(/[\r\n]+/g, ' '); this.paste = undefined;
        if (!this.approval) this.insert(value);
      } else this.paste += text || (key.name === 'return' ? '\n' : '');
      this.redraw(); return;
    }
    if (this.approval) {
      const a = this.approval;
      if (key.name === 'escape') { this.approval = undefined; a.resolve({ action: 'cancel' }); }
      else if (key.name === 'pageup') a.scroll = Math.max(0, a.scroll - 8);
      else if (key.name === 'pagedown') a.scroll += 8;
      else if (key.name === 'backspace') a.text = graphemes(a.text).slice(0, -1).join('');
      else if (key.name === 'return') {
        if (a.phase === 'code' && a.text.trim() && a.params.requestedSchema.properties.remember) {
          a.code = a.text.trim(); a.text = ''; a.phase = 'remember';
        } else {
          this.approval = undefined;
          if (!this.sending && (a.code || a.text.trim()) && !(a.phase === 'remember' && a.text.toLowerCase() === 'y')) this.readOnce = true;
          a.resolve(a.phase === 'code' && !a.text.trim() ? { action: 'decline' } : { action: 'accept', content: {
            code: a.code ?? a.text.trim(), remember: a.phase === 'remember' && a.text.toLowerCase() === 'y'
          } });
        }
      } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) a.text = (a.text + text).slice(0, 64);
      this.redraw(); return;
    }
    if (key.name === 'escape' || key.name === 'tab') {
      if (!this.busy) this.focus = this.focus === 'chat' || key.name === 'escape' ? 'rooms' : this.currentTitle ? 'chat' : 'rooms';
    } else if (key.ctrl && key.name === 'r') {
      await this.work(async () => {
        this.status = '새로고침 중…'; this.readOnce = false;
        if (!this.conversation.connected) await this.conversation.start();
        else await this.conversation.refresh();
        this.presentation.update(this.conversation.rooms);
        this.polling = !this.status.startsWith('오류:');
        this.resumeReads = this.polling && !this.readOnce;
        if (this.polling) this.status = '연결됨 · 새 메시지는 도착 시 바로 갱신합니다.';
        if (this.readOnce) this.pauseAfterOneRead();
      });
    } else if (this.focus === 'rooms' && (key.name === 'up' || key.name === 'down')) {
      this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + (key.name === 'up' ? -1 : 1)));
    } else if (this.focus === 'chat' && (key.name === 'pageup' || key.name === 'pagedown')) {
      this.scroll = Math.max(0, Math.min(10000, this.scroll + (key.name === 'pageup' ? 8 : -8)));
    } else if (key.name === 'return') {
      if (this.busy) return;
      if (this.focus === 'rooms') {
        const room = this.filtered[this.selected];
        if (!room) return;
        if (!room.openable) { this.status = '촬영 모드에서는 공개 대상으로 지정한 방만 열 수 있습니다.'; this.redraw(); return; }
        await this.work(async () => {
          this.readOnce = false; this.scroll = 0; this.draft = { text: '', cursor: 0 }; this.status = '대화 불러오는 중…';
          await this.conversation.open(room.id);
          if (this.currentTitle) { this.focus = 'chat'; this.polling = true; this.resumeReads = !this.readOnce; this.status = '연결됨 · 새 메시지는 도착 시 바로 갱신합니다.'; if (this.readOnce) this.pauseAfterOneRead(); }
        });
      } else if (this.draft.text.trim()) {
        const sent = this.draft.text;
        await this.work(async () => {
          this.status = '전송 중…';
          this.sending = true;
          try {
            await this.conversation.send(sent);
            this.status = '✓ 전송 요청 처리 완료 · 실제 도착은 카톡에서도 확인하세요.';
            if (this.conversation.readError && !this.conversation.live) {
              this.status += ' · 대화 자동 갱신 중지 · ' + conversationError(this.conversation.readError, this.options.demo);
            }
            if (this.status.startsWith('✓')) { this.draft = { text: '', cursor: 0 }; this.scroll = 0; }
          } finally { this.sending = false; }
        });
      }
    } else {
      if (this.sending && this.focus === 'chat') return;
      const field = this.focus === 'rooms' ? this.search : this.draft;
      const chars = graphemes(field.text);
      if (key.name === 'left') field.cursor = Math.max(0, field.cursor - 1);
      else if (key.name === 'right') field.cursor = Math.min(chars.length, field.cursor + 1);
      else if (key.name === 'home') field.cursor = 0;
      else if (key.name === 'end') field.cursor = chars.length;
      else if (key.name === 'backspace' && field.cursor) { chars.splice(--field.cursor, 1); field.text = chars.join(''); }
      else if (key.name === 'delete') { chars.splice(field.cursor, 1); field.text = chars.join(''); }
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.insert(text);
      if (this.focus === 'rooms') this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
    }
    this.redraw();
  }

  private insert(text: string): void {
    if (this.sending && this.focus === 'chat') return;
    if (this.focus === 'rooms') this.selected = 0;
    const field = this.focus === 'rooms' ? this.search : this.draft;
    const chars = graphemes(field.text), add = graphemes(shellText(text));
    if (field.text.length + text.length > 10000) return;
    chars.splice(field.cursor, 0, ...add); field.text = chars.join(''); field.cursor += add.length;
  }

  render(columns: number, rows: number): string {
    const width = Math.max(1, Math.min(columns - 1, 240));
    const height = Math.max(1, Math.min(rows, 80));
    if (width < 70 || height < 14) return '\x1b[H\x1b[2J' + fit('터미널을 넓혀 주세요 (72칸 × 14줄 이상). Ctrl+C 종료', width);
    const lines: string[] = [];
    const add = (s: string) => lines.push(fit(s, width));
    add(`kakao-max  |  터미널 메신저 · 모드: ${this.conversation.mode ?? '확인 중'} · 읽음 표시 안 보냄` + (this.options.demo ? '  ·  촬영 모드' : ''));
    const statusLines = wrap(this.busy ? '처리 중…  ·  작성 중인 내용은 유지됩니다.' : this.status, width).slice(0, height - 10);
    for (const line of statusLines) add(line);
    add('─'.repeat(width));
    if (this.approval) {
      const a = this.approval;
      const text = String(a.params.message ?? '').split('\n').flatMap(s => wrap(s, width));
      const bodyHeight = height - 5 - statusLines.length;
      a.scroll = Math.min(a.scroll, Math.max(0, text.length - bodyHeight));
      for (let i = 0; i < bodyHeight; i++) add(text[a.scroll + i] ?? '');
      add(a.phase === 'code' ? `승인 코드 > ${a.text}` : `${shellText(a.params.requestedSchema.properties.remember.title)}? [y/N] > ${a.text}`);
      add(`사람 확인 · PgUp/PgDn 내용 보기 (${a.scroll + 1}/${text.length}) · Enter 제출 · 빈 코드 거절 · Esc 취소`);
    } else {
      const leftWidth = Math.min(32, Math.floor(width / 3));
      const rightWidth = width - leftWidth - 3;
      const bodyHeight = height - 6 - statusLines.length;
      const visible = this.filtered;
      const start = Math.max(0, this.selected - bodyHeight + 2);
      const messages = this.conversation.messages.flatMap(m => wrap(this.presentation.message(m, this.conversation.userId), rightWidth));
      this.scroll = Math.min(this.scroll, Math.max(0, messages.length - bodyHeight + 1));
      const end = Math.max(0, messages.length - this.scroll);
      const view = messages.slice(Math.max(0, end - bodyHeight + 1), end);
      for (let i = 0; i < bodyHeight; i++) {
        const room = visible[start + i - 1];
        const left = i === 0 ? '대화방 · 검색해서 선택' : room ? `${start + i - 1 === this.selected ? '› ' : '  '}${room.label}${room.unread ? ` (${room.unread})` : ''}` : '';
        const right = i === 0 ? this.currentTitle ?? '방을 선택하면 최근 대화가 표시됩니다.' : view[i - 1] ?? '';
        const row = fit(left, leftWidth) + ' │ ' + fit(right, rightWidth);
        lines.push(i > 0 && room && start + i - 1 === this.selected && this.focus === 'rooms' ? '\x1b[7m' + row + '\x1b[0m' : row);
      }
      add('─'.repeat(width));
      const field = this.focus === 'rooms' ? this.search : this.draft;
      const label = this.focus === 'rooms' ? '방 검색 > ' : '메시지 > ';
      const chars = graphemes(field.text);
      let prefix = chars.slice(0, field.cursor).join('');
      while (terminalWidth(prefix) > width - terminalWidth(label) - 2) prefix = graphemes(prefix).slice(1).join('');
      add(label + prefix + '▏' + chars.slice(field.cursor).join(''));
      add('Ctrl+C 종료 · Enter 열기/전송 · Tab/Esc 방 목록 · PgUp/PgDn 스크롤 · Ctrl+R 새로고침');
    }
    return '\x1b[H' + lines.join('\r\n') + '\x1b[J';
  }
}

export async function runTerminalMessenger(args: string[], endpoint: { host: string; port: number }): Promise<void> {
  let demo = false, showRoom: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo') demo = true;
    else if (args[i] === '--show-room' && args[i + 1] && !args[i + 1].startsWith('--')) showRoom = args[++i];
    else throw new Error('사용법: kakao chat [--demo --show-room "공개할 방"]');
  }
  if (showRoom && !demo) throw new Error('--show-room은 --demo와 함께 사용하세요.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('대화형 터미널에서 실행하세요.');
  let view: TerminalMessenger;
  const render = () => { if (view && !view.closed) process.stdout.write(view.render(process.stdout.columns || 100, process.stdout.rows || 24)); };
  const client = new McpClient({ ...endpoint, timeoutMs: 150000,
    ...(!demo ? { onElicitation: (params: Record<string, any>) => view.askApproval(params) } : {}) });
  const reader = new McpConversationReader(client);
  view = new TerminalMessenger(reader, { identity: () => client.callTool('get_status'), send: async (chatId, text, requestId) => {
    try { const result = await sendMessage(client, { chatId, text }, requestId); return { ok: true, messageId: result.logId! }; }
    catch (e) { return { ok: false, code: (e as any).code || 'SEND_OUTCOME_UNKNOWN', message: (e as Error).message,
      uncertain: !(e instanceof McpToolError) }; }
  } }, { demo, showRoom }, render);
  let done!: () => void;
  const exit = new Promise<void>(resolve => { done = resolve; });
  const stop = () => { view.close(); client.close(); done(); };
  const onKey = (text: string, key: Key) => {
    if (key.ctrl && key.name === 'c') { stop(); return; }
    void view.key(text, key).catch(() => { view.status = '입력을 처리하지 못했습니다.'; render(); });
  };
  const wasRaw = process.stdin.isRaw;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('keypress', onKey); process.stdout.on('resize', render);
  process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  let reconnecting = false, started = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeReconnect: (() => void) | undefined;
  const unDisconnect = client.onDisconnect(error => {
    if (!started || view.closed || reconnecting) return;
    view.connectionLost(error); reconnecting = true;
    void (async () => {
      let delay = 1000;
      try {
        while (!view.closed) {
          await new Promise<void>(resolve => { resumeReconnect = resolve; reconnectTimer = setTimeout(resolve, delay); });
          if (view.closed) break;
          try { await client.connect(); if (!view.closed) await view.reconnected(); if (!client.connected && !view.closed) throw new Error('Connection lost during recovery'); break; }
          catch { delay = Math.min(delay * 2, 10000); }
        }
      } finally { reconnecting = false; }
    })();
  });
  try {
    render(); await client.connect(); await view.start();
    started = true;
    if (!view.closed) await exit;
  } catch (e) {
    throw new Error(conversationError(e, demo));
  } finally {
    unDisconnect(); if (reconnectTimer) clearTimeout(reconnectTimer); resumeReconnect?.();
    view.close(); client.close();
    process.stdin.off('keypress', onKey); process.stdout.off('resize', render);
    process.off('SIGTERM', stop); process.off('SIGHUP', stop);
    process.stdin.setRawMode(wasRaw); process.stdin.pause();
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    if (view.conversation.pending) console.error(`전송 결과 확인 필요 · 요청 ID ${view.conversation.pending.requestId}. 카카오톡을 먼저 확인하고 새 요청으로 다시 보내지 마세요.`);
  }
}
