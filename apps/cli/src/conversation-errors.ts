import { terminalText } from './terminal-text.ts';
const MESSAGES: Record<string, string> = {
  ACCOUNT_MISMATCH: '조회와 전송 연결의 계정이 일치하지 않습니다. 메시지를 보내지 않았습니다. 연결 설정을 확인하세요.',
  NOT_CONNECTED: '연결이 끊겼습니다. 다시 연결한 뒤 대화를 조회하세요.',
  TIMEOUT: '대화 조회가 지연됐습니다. Ctrl+R로 다시 조회할 수 있습니다.',
  INVALID_RESPONSE: '대화 응답을 확인할 수 없습니다. 데몬 버전을 확인하세요.',
  SEND_PENDING: '앞선 전송 결과를 먼저 확인하세요. 같은 내용을 새 요청으로 다시 보내지 마세요.',
  SEND_OUTCOME_UNKNOWN: '전송 결과가 불확실합니다. 카카오톡에서 확인하고 새 요청으로 다시 보내지 마세요.',
  ROOM_NOT_READ: 'ask 모드에서는 읽음 상태가 확인된 방만 조회할 수 있습니다. 승인 코드만으로 이 제한은 풀리지 않습니다.',
  POLICY_DENIED: '현재 데몬 정책 또는 방 권한으로 요청이 거절됐습니다. 일반 모드에서 권한을 확인하세요.',
  APPROVAL_REQUIRED: '조회 또는 전송에 사람 승인이 필요합니다. 일반 모드에서 확인하세요.'
};
export function conversationError(error: unknown, demo = false): string {
  const code = String((error as { code?: string })?.code ?? '');
  return '오류: ' + (MESSAGES[code] ?? (demo ? terminalText(code || '요청 처리 실패') : terminalText((error as Error).message)));
}
