// In-memory queue of prepared operations awaiting a human passkey decision, plus the content-free
// notification to the configured destination. Drafts live only here (RAM), never on disk; a restart
// drops them and the operator prepares again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { KakaoError, RECIPIENT_ACTIONS, type ApprovalStore, type ApprovalEvent, type RecipientPermissions, type WebAuthnAssertion } from '@kakao-max/core';

export interface PendingApproval {
  requestId: string; code: string; action: string; expiresAt: number; signingText: string;
  /** Image bytes verified against the signed SHA-256 descriptor; wiped on removal. */
  media: Array<{ bytes: Buffer; type: 'image/jpeg' | 'image/png' }>;
  token: Buffer;
}
export interface OfferResult { approvalUrl: string; code: string; expiresAt: number }

const MAX_PENDING = 5;
const MEDIA_LIMIT = 32 * 1024 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function shortCode(): string { return [...randomBytes(4)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); }
function imageType(b: Buffer): 'image/jpeg' | 'image/png' | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return undefined;
}
/** Every SHA-256 in the signed descriptor, in order, so previews provably show the signed bytes. */
function signedDigests(envelope: Record<string, any>): string[] {
  const m = envelope.message ?? {};
  if (Array.isArray(m.photos)) return m.photos.map((p: { sha256: string }) => p.sha256);
  return typeof m.sha256 === 'string' && m.type === 2 ? [m.sha256] : [];
}

export class ApprovalCenter {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly deps: {
    store: ApprovalStore; origin: string; now?: () => number;
    /** Room send permissions: approving may also allow later sends to the same room. */
    recipients?: RecipientPermissions;
    /** Sends one content-free message to the configured notification destination. */
    notify?: (text: string) => Promise<void>; notifyDelayMs?: number; log?: (line: string) => void;
  };
  private queued: Array<{ code: string; url: string }> = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(deps: ApprovalCenter['deps']) { this.deps = deps; }
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Register a prepared result for passkey review. Returns where the human approves it, or null when not applicable. */
  offer(prepared: { requestId?: unknown; signingText?: unknown; approvalRequired?: unknown; state?: unknown; expiresAt?: unknown }, media: Buffer[] = []): OfferResult | { approvalUrl: null; reason: string } | undefined {
    if (prepared.approvalRequired !== true || prepared.state !== 'prepared' || typeof prepared.signingText !== 'string' ||
        typeof prepared.requestId !== 'string' || typeof prepared.expiresAt !== 'number') return undefined;
    this.sweep();
    const existing = this.pending.get(prepared.requestId);
    if (existing && existing.signingText === prepared.signingText) return this.result(existing);
    if (existing) this.drop(existing.requestId); // re-prepared after a context change: the old text is no longer valid
    if (this.pending.size >= MAX_PENDING) return { approvalUrl: null, reason: `At most ${MAX_PENDING} operations can await passkey approval; wait for some to finish` };
    const envelope = JSON.parse(prepared.signingText) as Record<string, any>;
    const entry: PendingApproval = { requestId: prepared.requestId, code: shortCode(), action: String(envelope.action), expiresAt: prepared.expiresAt,
      signingText: prepared.signingText, media: this.previews(envelope, media), token: randomBytes(18) };
    this.pending.set(entry.requestId, entry);
    const result = this.result(entry);
    this.enqueue(entry.code, result.approvalUrl);
    return result;
  }
  private previews(envelope: Record<string, any>, media: Buffer[]): PendingApproval['media'] {
    const digests = signedDigests(envelope), used = [...this.pending.values()].reduce((n, p) => n + p.media.reduce((m, x) => m + x.bytes.length, 0), 0);
    if (!digests.length || digests.length !== media.length || used + media.reduce((n, b) => n + b.length, 0) > MEDIA_LIMIT) return [];
    const out: PendingApproval['media'] = [];
    for (const [i, bytes] of media.entries()) {
      const type = imageType(bytes);
      if (!type || createHash('sha256').update(bytes).digest('hex') !== digests[i]) { for (const m of out) m.bytes.fill(0); return []; }
      out.push({ bytes: Buffer.from(bytes), type });
    }
    return out;
  }
  private result(entry: PendingApproval): OfferResult {
    // The token rides in the fragment: it never reaches server logs or a Referer header.
    return { approvalUrl: `${this.deps.origin}/a/${entry.requestId}#${entry.token.toString('base64url')}`, code: entry.code, expiresAt: entry.expiresAt };
  }
  private enqueue(code: string, url: string): void {
    if (!this.deps.notify) return;
    this.queued.push({ code, url });
    this.timer ??= setTimeout(() => { void this.flush(); }, this.deps.notifyDelayMs ?? 30_000);
    this.timer.unref?.();
  }
  /** One coalesced message: codes and links only, never action names, rooms or text. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const batch = this.queued.splice(0);
    if (!batch.length || !this.deps.notify) return;
    const text = [`[kakao-max] 승인 요청 ${batch.length}건`, ...batch.map(b => `#${b.code} ${b.url}`)].join('\n');
    try { await this.deps.notify(text); }
    catch (error) { (this.deps.log ?? (l => process.stderr.write(l + '\n')))(`[approval] notification failed: ${error instanceof KakaoError ? error.code : 'error'}`); }
  }
  private sweep(): void {
    for (const p of this.pending.values()) if (p.expiresAt <= this.now()) this.drop(p.requestId);
  }
  private drop(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    for (const m of p.media) m.bytes.fill(0);
    this.pending.delete(requestId);
  }
  /** Constant-time token check; an unknown, expired or wrong-token request is indistinguishable. */
  get(requestId: string, token: string | undefined): PendingApproval {
    this.sweep();
    const p = this.pending.get(requestId);
    const given = Buffer.from(typeof token === 'string' ? token : '', 'base64url');
    if (!p || given.length !== p.token.length || !timingSafeEqual(given, p.token)) throw new KakaoError('NOT_FOUND', 'No such pending approval');
    return p;
  }
  /** Whether this pending send can also allow its room for later sends. */
  rememberable(p: PendingApproval): string | undefined {
    const e = JSON.parse(p.signingText) as Record<string, any>;
    return this.deps.recipients && (RECIPIENT_ACTIONS as readonly string[]).includes(e.action) && typeof e.message?.chatId === 'string' ? e.message.chatId : undefined;
  }
  approve(requestId: string, token: string | undefined, assertion: WebAuthnAssertion, remember = false): void {
    const p = this.get(requestId, token), chatId = this.rememberable(p);
    this.deps.store.approve(requestId, p.signingText, assertion);
    // Only after the passkey assertion verified; the room is the one in the signed text, not caller input.
    if (remember && chatId) this.deps.recipients!.grant(chatId, 'passkey');
    this.drop(requestId);
  }
  reject(requestId: string, token: string | undefined): void {
    this.get(requestId, token);
    this.deps.store.reject(requestId);
    this.drop(requestId);
  }
  /** Long-poll for a decision; content-free. */
  async wait(requestId: string, timeoutMs: number): Promise<{ requestId: string; state: string }> {
    const store = this.deps.store;
    const state = store.state(requestId);
    if (state !== 'awaiting_approval') return { requestId, state };
    const row = Math.max(0, Math.min(timeoutMs, 120_000));
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); store.events.off('change', listener); resolve(); };
      const listener = (e: ApprovalEvent) => { if (e.requestId === requestId) done(); };
      const timer = setTimeout(done, row);
      store.events.on('change', listener);
    });
    return { requestId, state: store.state(requestId) };
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const id of [...this.pending.keys()]) this.drop(id);
  }
}

let center: ApprovalCenter | undefined;
let waitStore: ApprovalStore | undefined;
/** Wired once at daemon start; tests set their own. */
export function setApprovalCenter(value: ApprovalCenter | undefined, store?: ApprovalStore): void { center = value; waitStore = store; }
/** Attach the passkey approval link to a prepare result when the listener is enabled. */
export function withApproval<T extends Record<string, unknown>>(prepared: T, media: Buffer[] = []): T & { approval?: unknown } {
  const offer = center?.offer(prepared, media);
  return offer ? { ...prepared, approval: offer } : prepared;
}
export async function waitForApproval(requestId: string, timeoutMs: number): Promise<{ requestId: string; state: string }> {
  if (center) return center.wait(requestId, timeoutMs);
  if (!waitStore) throw new KakaoError('NOT_CONNECTED', 'Approval store is not ready');
  return { requestId, state: waitStore.state(requestId) };
}
