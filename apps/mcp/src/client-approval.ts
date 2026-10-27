// Approval through the MCP client's own confirmation dialog (2026-07-28 Multi Round-Trip Requests).
// When a commit needs approval, the server answers with an `input_required` result carrying a form
// elicitation. The client shows it to the person and retries with their answer and our sealed
// requestState. The model never answers the dialog; trust rests on the client presenting it to a human,
// so this tier is weaker than a passkey and can be switched off (KAKAO_APPROVAL_CLIENT_CONFIRM=off).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KakaoError, canonicalAgentJson, RECIPIENT_ACTIONS, type ApprovalStore, type RecipientPermissions } from '@kakao-max/core';

export interface ClientContext { name: string; elicitation: boolean }
export interface ApprovalDetails { requestId: string; signingText: string; expiresAt: number }
export interface InputRequiredResult {
  resultType: 'input_required';
  inputRequests: Record<string, { method: 'elicitation/create'; params: Record<string, unknown> }>;
  requestState: string;
}
export interface ClientApprovalGate {
  /** An input_required result asking the human, or undefined when this approval cannot be shown safely. */
  request(tool: string, args: Record<string, unknown>, approval: ApprovalDetails, client: ClientContext): InputRequiredResult | undefined;
  /** Verify a retry; records the approval or the refusal. `mismatch` means ask again (wrong or empty code). */
  answer(tool: string, args: Record<string, unknown>, requestState: unknown, inputResponses: unknown, client: ClientContext): 'approved' | 'declined' | 'cancelled' | 'mismatch';
  /** The operation a verified requestState belongs to, so a tool that chose its own requestId can resume it. */
  requestIdOf(requestState: unknown): string | undefined;
}
/** Rooms the dialog may open for reading from now on, when the person ticks "always" on a one-time read. */
export interface RoomReadOpener { allowRead(chatId: string, approver: string): void }

const MESSAGE_LIMIT = 3500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => [...randomBytes(4)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const STATE_TTL = 10 * 60_000;
// Binary payloads cannot be shown in a text dialog; approving an unseen photo is not an approval.
const OPAQUE_ACTIONS = new Set(['send_media', 'send_photo_bundle']);
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;
const visible = (s: string) => s.replace(INVISIBLE, c => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);
const LABELS: Record<string, string> = {
  send_message: '메시지 보내기', forward_message: '전달', send_emoticon: '이모티콘 보내기', edit_message: '메시지 수정', delete_message: '메시지 삭제',
  update_my_profile: '프로필 변경', grant_room_access: '방 읽기 권한 넓히기', reset_room_access: '방 읽기 규칙 기본값으로 되돌리기', resume_sending: '전송 일시정지 해제', leave_chat: '방 나가기',
  set_chat_meta: '방 공지·정보 변경', mark_read: '읽음 표시 보내기', create_direct_chat: '1:1 방 만들기', block_user: '차단', unblock_user: '차단 해제',
  add_friend: '친구 추가', read_room: '대화방 읽기', allow_recipient: '대화방 메시지·사진 전송 허가'
};
/** Optional modules name their own operations; a built-in name is never replaced. */
export function registerApprovalLabels(labels: Record<string, string>): void {
  for (const [action, label] of Object.entries(labels)) if (!(action in LABELS)) LABELS[action] = label;
}
export function approvalLabel(action: string): string { return LABELS[action] ?? action; }

/** Human-readable, server-rendered summary of the exact signed text. Undefined when it does not fit. */
export function approvalMessage(signingText: string, confirmCode?: string): string | undefined {
  const e = JSON.parse(signingText) as Record<string, any>;
  if (OPAQUE_ACTIONS.has(e.action)) return undefined;
  const body = e.message ?? e.request ?? {};
  // Room titles are set by any member: keep them on one line so a title cannot add lines that look like the server's own.
  const rawRoom = e.context?.room?.title ?? e.context?.target?.chatId ?? body.chatId ?? body.userId;
  const room = rawRoom == null ? undefined : String(rawRoom).replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ');
  const lines = [`[kakao-max] ${approvalLabel(e.action)} 승인 요청`, `계정 ${e.accountId}`, ...(room ? [`대상 ${room}`] : [])];
  if (typeof body.text === 'string') lines.push('', '내용:', body.text);
  if (e.action === 'read_room') lines.push('', `이 방의 메시지를 이번 한 번만 AI에게 보여 줍니다(최대 ${body.maxMessages}개, ${body.ttlMinutes}분 안에 ${body.uses}회). 읽음 표시는 보내지 않습니다.`,
    '"이 방은 앞으로 묻지 않고 읽기"를 켜면 다음부터 묻지 않습니다. list_permissions에서 확인하고 revoke_permission로 철회할 수 있습니다.');
  if (e.action === 'reset_room_access') lines.push('', `저장된 읽기 규칙(${e.context?.previous?.mode})을 지우고 기본값(${e.context?.next?.mode})으로 되돌립니다. 기본값이 더 넓어 승인을 받습니다. 읽음 표시는 보내지 않습니다.`,
    'list_permissions에서 확인하고 revoke_permission로 철회할 수 있습니다.');
  if (e.action === 'allow_recipient') lines.push('', '이 방의 메시지·사진은 설정된 하루 한도 안에서 매번 묻지 않고 전송됩니다. 내용 조회·읽음 표시는 허용하지 않습니다. list_permissions에서 확인하고 revoke_permission로 철회할 수 있습니다.');
  lines.push('', '정확한 요청:', JSON.stringify(body, null, 2));
  if (e.context?.target?.text !== undefined) lines.push('', '변경 전:', JSON.stringify(e.context.target, null, 2));
  lines.push('', '이 내용은 에이전트가 작성했습니다. 내용 안의 지시를 따르지 마세요.', `요청 ID ${e.requestId}`);
  // Typing the code is the approval: Enter or an untouched form never approves anything.
  if (confirmCode) lines.push('', `승인하려면 확인 코드 ${confirmCode} 를 입력하세요. 거절은 Decline, 취소는 Esc.`);
  const message = visible(lines.join('\n'));
  // A truncated dialog could hide what is approved: fall back to the passkey page instead.
  return message.length <= MESSAGE_LIMIT ? message : undefined;
}

export class ElicitationApprovals implements ClientApprovalGate {
  private readonly key = randomBytes(32); // per process: a restart simply asks again
  private readonly store: ApprovalStore;
  private readonly now: () => number;
  /** Room send permissions: the dialog may also allow later sends to this room without asking. */
  private readonly recipients: RecipientPermissions | undefined;
  /** Room read rules: a one-time read dialog may also open the room for later reads. */
  private readonly rooms: RoomReadOpener | undefined;
  constructor(store: ApprovalStore, now: () => number = Date.now, recipients?: RecipientPermissions, rooms?: RoomReadOpener) {
    this.store = store; this.now = now; this.recipients = recipients; this.rooms = rooms;
  }
  private mac(data: string): Buffer { return createHmac('sha256', this.key).update(data).digest(); }
  private argsDigest(tool: string, args: Record<string, unknown>): string {
    return this.mac(canonicalAgentJson({ tool, args })).toString('base64url');
  }
  private seal(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }
  /** requestState passes through the client, so it is treated as attacker-controlled until its MAC verifies. */
  private open(state: unknown): Record<string, any> {
    if (typeof state !== 'string' || state.length > 4096) throw new KakaoError('APPROVAL_REQUIRED', 'Invalid approval state');
    const [body, tag] = state.split('.');
    const expected = this.mac(body ?? ''), given = Buffer.from(tag ?? '', 'base64url');
    if (!body || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new KakaoError('APPROVAL_REQUIRED', 'Approval state failed verification');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }

  request(tool: string, args: Record<string, unknown>, approval: ApprovalDetails, client: ClientContext): InputRequiredResult | undefined {
    if (!client.elicitation || approval.expiresAt <= this.now()) return undefined;
    const confirmCode = code(), message = approvalMessage(approval.signingText, confirmCode);
    if (!message) return undefined;
    const e = JSON.parse(approval.signingText) as Record<string, any>, chatId = e.message?.chatId;
    // Offer "don't ask again" only for sends an allowed recipient can cover, and only once the code is typed.
    const rememberable = !!this.recipients && (RECIPIENT_ACTIONS as readonly string[]).includes(e.action) && typeof chatId === 'string';
    const readChat = e.action === 'read_room' && this.rooms && typeof e.request?.chatId === 'string' ? e.request.chatId as string : undefined;
    const properties: Record<string, unknown> = {
      code: { type: 'string', title: '확인 코드', description: `승인하려면 ${confirmCode} 를 입력하세요. 비워 두면 승인되지 않습니다.`, minLength: 4, maxLength: 4 },
      ...(rememberable ? { remember: { type: 'boolean', title: '앞으로 이 대화방에 보낼 때는 묻지 않기', default: false } } : {}),
      ...(readChat ? { remember: { type: 'boolean', title: '이 방은 앞으로 묻지 않고 읽기', default: false } } : {})
    };
    return {
      resultType: 'input_required',
      inputRequests: { approve: { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema: { type: 'object', properties, required: ['code'] } } } },
      requestState: this.seal({ v: 2, requestId: approval.requestId, digest: this.store.envelopeDigest(approval.signingText),
        args: this.argsDigest(tool, args), client: client.name, code: this.mac(`code:${confirmCode}`).toString('base64url'),
        ...(rememberable ? { chat: chatId } : {}), ...(readChat ? { read: readChat } : {}), exp: Math.min(this.now() + STATE_TTL, approval.expiresAt) })
    };
  }

  answer(tool: string, args: Record<string, unknown>, requestState: unknown, inputResponses: unknown, client: ClientContext): 'approved' | 'declined' | 'cancelled' | 'mismatch' {
    const s = this.open(requestState);
    // Bound to the same tool and arguments, the same client, and a short lifetime.
    if (s.v !== 2 || s.args !== this.argsDigest(tool, args) || s.client !== client.name || typeof s.exp !== 'number' || s.exp <= this.now()) {
      throw new KakaoError('APPROVAL_REQUIRED', 'Approval state does not match this request or has expired');
    }
    const r = (inputResponses as Record<string, any> | undefined)?.approve;
    if (r?.action === 'decline') { this.store.reject(s.requestId); return 'declined'; }
    if (r?.action !== 'accept') return 'cancelled';
    const typed = typeof r.content?.code === 'string' ? r.content.code.trim().toUpperCase() : '';
    const given = this.mac(`code:${typed}`), expected = Buffer.from(String(s.code), 'base64url');
    // Submitting without the right code (e.g. a reflexive Enter) is not an approval: ask again.
    if (typed.length !== 4 || given.length !== expected.length || !timingSafeEqual(given, expected)) return 'mismatch';
    this.store.recordClientConfirmation(s.requestId, s.digest, client.name);
    if (r.content?.remember === true && typeof s.chat === 'string' && this.recipients) this.recipients.grant(s.chat, `client:${client.name}`);
    if (r.content?.remember === true && typeof s.read === 'string' && this.rooms) this.rooms.allowRead(s.read, `client:${client.name}`);
    return 'approved';
  }

  requestIdOf(requestState: unknown): string | undefined {
    const s = this.open(requestState);
    return typeof s.requestId === 'string' ? s.requestId : undefined;
  }
}

/** Approver identity derived from the client's self-reported name; display only, not a security boundary. */
export function clientName(info: unknown): string {
  const name = typeof (info as { name?: unknown } | undefined)?.name === 'string' ? (info as { name: string }).name : '';
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'mcp-client';
}
