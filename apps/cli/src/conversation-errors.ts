import { terminalText } from './terminal-text.ts';
const TRUST_MODE_HELP = 'trust 모드에서는 이 제한이 해제됩니다. 전환은 서버 설정에서 하며, 연결된 AI 전체의 읽기·전송 권한에 영향을 줍니다. 설정의 위험 안내를 확인하고 직접 선택하세요.';
const MESSAGES: Record<string, string> = {
  ACCOUNT_MISMATCH: '조회와 전송 연결의 계정이 일치하지 않습니다. 메시지를 보내지 않았습니다. 연결 설정을 확인하세요.',
  NOT_SUPPORTED: '데몬이 이벤트 구독을 지원하지 않습니다. 데몬과 CLI를 함께 업데이트하세요.',
  NOT_FOUND: '이 대화방을 더 이상 사용할 수 없습니다. 방 목록을 새로 확인하세요.',
  NOT_CONNECTED: '연결이 끊겼습니다. 다시 연결한 뒤 대화를 조회하세요.',
  RATE_LIMITED: '요청 한도에 도달했습니다. 자동 갱신 중지 · 한도 회복 후 Ctrl+R로 다시 조회하세요.',
  TIMEOUT: '대화 조회가 지연됐습니다. Ctrl+R로 다시 조회할 수 있습니다.',
  INVALID_RESPONSE: '대화 응답 형식을 확인할 수 없습니다. Ctrl+R로 다시 조회하고, 반복되면 오류를 점검하세요.',
  SEND_PENDING: '앞선 전송 결과를 먼저 확인하세요. 같은 내용을 새 요청으로 다시 보내지 마세요.',
  SEND_OUTCOME_UNKNOWN: '전송 결과가 불확실합니다. 카카오톡에서 확인하고 새 요청으로 다시 보내지 마세요.',
  ROOM_NOT_READ: 'ask 모드: 읽음 상태가 확인된 방만 조회할 수 있습니다. 공식 앱에서 읽고 Ctrl+R을 누르세요. ' + TRUST_MODE_HELP,
  POLICY_DENIED: '현재 데몬 정책 또는 방 권한으로 요청이 거절됐습니다. 일반 모드에서 권한을 확인하세요.',
  APPROVAL_REQUIRED: '조회 또는 전송에 사람 승인이 필요합니다. 일반 모드에서 확인하세요.'
};
export function conversationError(error: unknown, demo = false): string {
  const code = String((error as { code?: string })?.code ?? '');
  if (code === 'ROOM_NOT_READ' && (error as { details?: { reason?: unknown } })?.details?.reason === 'unread_unknown') {
    return '오류: ask 모드: 서버의 읽음 상태를 확인할 수 없습니다. 이미 읽었어도 동기화 정보가 없으면 조회가 차단됩니다. Ctrl+R로 다시 확인하세요. ' + TRUST_MODE_HELP;
  }
  return '오류: ' + (MESSAGES[code] ?? (demo ? terminalText(code || '요청 처리 실패') : terminalText((error as Error).message)));
}
