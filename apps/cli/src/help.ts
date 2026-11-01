// ----------------------------------------------------------------------------
// `kakao help`: a grouped one-line-per-command overview, and `kakao help <명령어>`
// (or `<명령어> --help`) for one command's usage, options and notes. Daemon tool
// commands come from the COMMANDS table, so new commands show up here by themselves.
// ----------------------------------------------------------------------------

import { COMMANDS } from './commands.ts';

interface HelpEntry {
  usage: string;
  summary: string;
  aliases?: string[];
  group?: string;
  options?: string[];
  notes?: string[];
  examples?: string[];
}

const APPROVAL_NOTE = '승인이 필요하면 링크가 출력됩니다. 승인한 뒤 같은 명령에 --request-id <id> 를 붙여 다시 실행하세요.';

/** Commands implemented in index.ts with their own formatted output. */
const BUILTINS: Record<string, HelpEntry> = {
  chat: {
    usage: 'chat [--demo] [--show-room "<방 이름>"]', summary: '방 검색·방향키·입력창으로 쓰는 터미널 메신저',
    notes: ['읽기와 보내기 모두 데몬의 ask/trust 모드와 방 규칙을 따릅니다. 읽음 표시는 보내지 않습니다.', '--demo 는 --show-room 으로 고른 방 말고 다른 방 이름을 숨기는 촬영 모드입니다.']
  },
  shell: {
    usage: 'shell [--demo] [--show-room "<방 이름>"]', summary: 'ls/cd/Tab 으로 방을 고르고 대화하기',
    notes: ['--demo 는 --show-room 으로 고른 방 말고 다른 방 이름을 숨기는 촬영 모드입니다.'],
    examples: ['kakao shell --demo --show-room "공개할 방"']
  },
  ls:{ usage: 'ls', aliases: ['list'], summary: '대화방 목록과 안읽은 메시지 (명령 없이 kakao 만 실행해도 같음)' },
  status: { usage: 'status', summary: '데몬과 카카오톡 연결 상태' },
  friends: { usage: 'friends [검색어]', aliases: ['contacts'], summary: '친구 목록과 이름 검색', examples: ['kakao friends 홍길동'] },
  history: {
    usage: 'history <대화방> [개수] [--read-grant <id>] [--request-id <id>]', aliases: ['hist'], summary: '대화 내역 조회 (기본 20개)',
    notes: ['첨부가 있으면 바로 실행할 수 있는 📎 download 명령을 함께 보여 줍니다.', '닫힌 방은 승인 링크가 출력됩니다. 승인한 뒤 --request-id 를 붙여 한 번 읽습니다.'],
    examples: ['kakao history "홍길동" 10']
  },
  search: {
    usage: 'search "<검색어>" <대화방> [--read-grant <id>] [--request-id <id>]', aliases: ['find'], summary: '한 방의 메시지 검색 (여러 방은 vault-search)',
    notes: ['닫힌 방은 history 와 같이 승인 후 --request-id 로 다시 실행합니다.'], examples: ['kakao search "회의" "개발팀"']
  },
  download: {
    usage: 'download <대화방> <token> <저장경로> --message-id <id> [--type photo|video|audio|file] [--mini] [--read-grant <id>]',
    aliases: ['dl', 'download-media'], summary: '받은 사진·동영상·음성·파일 저장 (이 컴퓨터에 씀)',
    notes: ['token, message-id, type 은 kakao history 의 📎 줄에 그대로 나옵니다.', '저장경로에 파일이 이미 있으면 덮어쓰지 않고 실패합니다.']
  },
  send: {
    usage: 'send <대화방> "<메시지>" [--request-id <id>]', summary: '메시지 보내기 (허용한 방은 바로, 아니면 승인 링크)',
    notes: [APPROVAL_NOTE, '결과 불확실이 나오면 휴대폰에서 확인하고 다시 보내지 마세요.'],
    examples: ['kakao send self "나에게 메모"', 'kakao send 1 "안녕하세요!"']
  },
  'send-photo': { usage: 'send-photo <대화방> <파일경로> [--request-id <id>]', aliases: ['photo'], summary: '사진 보내기 (승인 방식은 send 와 같음)', notes: [APPROVAL_NOTE] },
  'send-file': { usage: 'send-file <대화방> <파일경로> [--request-id <id>]', aliases: ['file'], summary: '파일 보내기 (승인 방식은 send 와 같음)', notes: [APPROVAL_NOTE] },
  read: {
    usage: 'read <대화방> [--request-id <id>]', summary: '읽음 표시 보내기 (상대에게 보임, 항상 승인)', group: 'chats',
    notes: ['메시지를 읽는 명령은 history 입니다. read 는 상대방 화면의 "1" 을 지웁니다.', APPROVAL_NOTE]
  },
  submit: {
    usage: 'submit <request.json>', summary: '요청 파일(본인만 읽기, 0600) 실행: 승인 요청 → 승인 후 같은 파일로 다시 실행',
    notes: ['파일에는 requestId(UUID)와 action, 그 인자를 넣습니다. 같은 파일을 다시 실행하면 같은 요청을 이어갑니다.']
  },
  test: {
    usage: 'test [--group-only] [--chat-id <id>]', aliases: ['smoke'], summary: '읽기 전용 스모크 테스트 (보내거나 승인을 요청하지 않음)'
  },
  help: { usage: 'help [명령어]', aliases: ['commands', '-h', '--help'], summary: '명령어 목록, 또는 한 명령어의 자세한 사용법' },
  version: { usage: 'version', aliases: ['--version', '-v'], summary: '설치된 kakao-max 버전' },
  setup: {
    usage: 'setup [--config [--ssh user@host] [--listen loopback:port] | --doctor | --repair | --update | --mode ask|trust [--accept-risk] [--env <경로>]]',
    summary: '데몬 설치·연결 마법사, 진단, 복구, 업데이트, 에이전트 모드',
    notes: ['--mode trust 는 ask 의 안읽은 방 제한을 풀어 바로 읽고 보내게 합니다. 이 데몬의 모든 클라이언트에 적용되며, deny 규칙과 운영자 상한은 그대로입니다.', '--update 는 패키지 설치용입니다. 소스 설치는 운영자 배포 절차로 업데이트합니다.'],
    examples: ['kakao setup --doctor', 'kakao setup --mode trust --accept-risk']
  },
  web: { usage: 'web', summary: '내 브라우저용 로컬 웹 화면 시작' },
  approver: { usage: 'approver enroll|list|remove <id>', summary: '승인 패스키 관리 (데몬 서버 터미널에서)' }
};

const CATEGORIES: Array<[string, string[]]> = [
  ['기본', ['chat', 'shell', 'ls', 'status', 'help', 'version', 'test']],
  ['설치·관리', ['setup', 'web', 'approver']],
  ['대화 읽기', ['history', 'search', 'download', 'find-room', 'unread', 'meta']],
  ['보내기', ['send', 'send-photo', 'send-file', 'forward', 'emoticon', 'submit']],
  ['내 메시지 관리', ['edit', 'delete', 'hide']],
  ['방 관리', ['read', 'dm', 'create-dm', 'members', 'set-meta', 'leave']],
  ['친구·프로필', ['friends', 'sync-friends', 'blocked', 'block', 'unblock', 'add-friend', 'profile', 'friend-profile', 'status-message']],
  ['권한·승인', ['perms', 'allow', 'allow-read', 'room-rule', 'room-default', 'revoke', 'pause', 'resume', 'wait', 'op']],
  ['이벤트', ['events-claim', 'events-ack']],
  ['보관함 (vault)', ['vault-export', 'vault-links', 'vault-schedule', 'vault-search', 'vault-stats']]
];

function entry(name: string): HelpEntry | undefined {
  if (Object.hasOwn(BUILTINS, name)) return BUILTINS[name];
  if (!Object.hasOwn(COMMANDS, name)) return;
  const cmd = COMMANDS[name];
  const options = Object.entries(cmd.options ?? {}).map(([flag, o]) => `--${flag}${o.type === 'string' ? ' <값>' : ''}${o.multiple ? ' (여러 번 가능)' : ''}`);
  return { usage: cmd.usage, summary: cmd.summary, group: cmd.group, options: [...options, '--request-id <id>'],
    notes: ['결과는 데몬 도구의 JSON 그대로 출력됩니다.'] };
}

/** Every name the help knows, aliases included, mapped to its main name. */
export function helpNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of [...Object.keys(BUILTINS), ...Object.keys(COMMANDS)]) {
    names.set(name, name);
    for (const alias of BUILTINS[name]?.aliases ?? []) names.set(alias, name);
  }
  return names;
}

export const HELP_CATEGORIES = CATEGORIES;

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]; row[j] = next;
    }
  }
  return row[b.length];
}

/** Closest known commands for a typo: same prefix first, then at most two edits away. */
export function suggest(input: string): string[] {
  const q = input.toLowerCase();
  const names = [...new Set(helpNames().values())];
  const prefixed = names.filter(n => q.length >= 2 && (n.startsWith(q) || q.startsWith(n)));
  const near = names.map(n => [n, distance(q, n)] as const).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1]).map(([n]) => n);
  return [...new Set([...prefixed, ...near])].slice(0, 3);
}

export interface Paint { bold(s: string): string; cyan(s: string): string; gray(s: string): string; yellow(s: string): string }
export const plain: Paint = { bold: s => s, cyan: s => s, gray: s => s, yellow: s => s };

export function renderOverview(p: Paint = plain): string {
  const width = Math.max(...CATEGORIES.flatMap(([, names]) => names.map(n => n.length))) + 2;
  const lines = [p.bold('kakao-max 터미널 CLI') + p.gray('  — 데몬(MCP)에 연결해 카카오톡을 다룹니다'), '', `${p.bold('사용법:')} kakao <명령어> [인자] [옵션]`, ''];
  for (const [title, names] of CATEGORIES) {
    lines.push(p.bold(title));
    for (const name of names) {
      const e = entry(name)!;
      lines.push(`  ${p.cyan(name.padEnd(width))}${e.summary}${e.group ? p.gray(` [${e.group}]`) : ''}`);
    }
    lines.push('');
  }
  lines.push(
    `${p.bold('<대화방>')} 지정: ${p.yellow('#3')} (kakao ls 번호) · ${p.yellow('self')} (나와의 채팅) · ${p.yellow('"이름"')} (유일하게 맞는 방) · ${p.yellow('채팅 ID')}`,
    `${p.gray('[chats] 등은 데몬에서 KAKAO_MCP_TOOL_GROUPS 로 켜야 하는 도구 묶음입니다.')}`,
    `자세한 사용법: ${p.cyan('kakao help <명령어>')}  또는  ${p.cyan('kakao <명령어> --help')}`
  );
  return lines.join('\n');
}

export function renderCommand(input: string, p: Paint = plain): string | undefined {
  const name = helpNames().get(input);
  const e = name && entry(name);
  if (!name || !e) return;
  const lines = [`${p.bold('kakao ' + name)} — ${e.summary}`, '', `${p.bold('사용법:')} kakao ${e.usage}`];
  if (e.aliases?.length) lines.push(`${p.bold('별칭:')}   ${e.aliases.join(', ')}`);
  if (e.group) lines.push(`${p.bold('묶음:')}   ${e.group} ${p.gray('(데몬의 KAKAO_MCP_TOOL_GROUPS 에 있어야 합니다)')}`);
  if (e.options?.length) lines.push('', p.bold('옵션:'), ...e.options.map(o => `  ${o}`));
  if (e.notes?.length) lines.push('', ...e.notes.map(n => `• ${n}`));
  if (e.examples?.length) lines.push('', p.bold('예시:'), ...e.examples.map(x => `  $ ${x}`));
  return lines.join('\n');
}
