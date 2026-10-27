// ----------------------------------------------------------------------------
// Human/agent-readable one-line preview of a chat log for list views.
//
// Non-text logs carry JSON or placeholder bodies (VoIP signalling, feed events),
// which are noise in list_chats. Full raw text stays in the MessageStore.
// ----------------------------------------------------------------------------

const TYPE_LABELS: Record<number, string> = {
  2: '[사진]',
  3: '[동영상]',
  4: '[연락처]',
  5: '[음성메시지]',
  6: '[이모티콘]',
  12: '[이모티콘]',
  14: '[투표]',
  16: '[위치]',
  18: '[파일]',
  20: '[이모티콘]',
  22: '[이모티콘]',
  25: '[이모티콘]',
  27: '[사진 묶음]',
  51: '[통화]',
  97: '[톡게시판]',
  98: '[톡게시판]'
};

const VOIP_EVENTS: Record<string, string> = {
  invite: '[통화 시작]',
  canceled: '[통화 취소]',
  bye: '[통화 종료]',
  noanswer: '[부재중 통화]',
  deny: '[통화 거절]'
};

export function previewText(text: string | undefined, type: number | undefined): string {
  const body = (text ?? '').trim();
  if (type === 0) return '[알림]';
  if (type === 51) {
    try {
      const ev = JSON.parse(body)?.type;
      return VOIP_EVENTS[ev] ?? '[통화]';
    } catch {
      return '[통화]';
    }
  }
  if (type !== undefined && TYPE_LABELS[type]) {
    // Keep a caption if the body is human text (e.g. "사진 28장"), not a placeholder/JSON.
    const label = TYPE_LABELS[type];
    return body && !body.startsWith('{') && body !== 'photo' ? `${label} ${body}` : label;
  }
  if (body.startsWith('{')) return type !== undefined ? `[type ${type}]` : '[알 수 없는 메시지]';
  return body.replace(/\s+/g, ' ');
}
