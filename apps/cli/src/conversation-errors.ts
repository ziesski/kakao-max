import { terminalText } from './terminal-text.ts';
const MESSAGES: Record<string, string> = {
  ACCOUNT_MISMATCH: '조회와 전송 연결의 계정이 일치하지 않습니다. 메시지를 보내지 않았습니다. 연결 설정을 확인하세요.',
  USER_API_UNAVAILABLE: '사람용 조회 API에 연결할 수 없습니다. 데몬 버전과 소켓·SSH 실행 계정을 확인하세요.',
  VERSION_MISMATCH: '사람용 조회 API 버전이 맞지 않습니다. 데몬과 클라이언트 버전을 확인하세요.',
  NOT_CONNECTED: '연결이 끊겼습니다. 다시 연결한 뒤 대화를 조회하세요.',
  TIMEOUT: '대화 조회가 지연됐습니다. Ctrl+R로 다시 조회할 수 있습니다.',
  INVALID_RESPONSE: '대화 응답을 확인할 수 없습니다. 데몬 버전을 확인하세요.',
  SEND_PENDING: '앞선 전송 결과를 먼저 확인하세요. 같은 내용을 새 요청으로 다시 보내지 마세요.',
  SEND_OUTCOME_UNKNOWN: '전송 결과가 불확실합니다. 카카오톡에서 확인하고 새 요청으로 다시 보내지 마세요.',
  APPROVAL_REQUIRED: '전송에 사람 승인이 필요합니다. 촬영 전에 일반 모드에서 확인하세요.'
};
export function conversationError(error: unknown, demo = false): string {
  const code = String((error as { code?: string })?.code ?? '');
  return '오류: ' + (MESSAGES[code] ?? (demo ? terminalText(code || '요청 처리 실패') : terminalText((error as Error).message)));
}
