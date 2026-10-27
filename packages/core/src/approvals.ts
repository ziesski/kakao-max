// Human approval for prepared agent operations: WebAuthn passkeys verified in-process with node:crypto
// (no CBOR or attestation library), an operator-controlled approver registry, and a content-free
// durable record of which envelope an approver signed. The daemon holds no approval private key.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { COMMIT_WINDOW_MS, type AgentSendJournal } from './agent-send.ts';
import { KakaoError } from './errors.ts';
import { isOwnerOnly, fsyncDir } from './private-fs.ts';

export const WEBAUTHN_ALGORITHMS = [-8, -7, -257] as const; // EdDSA, ES256, RS256
export type WebAuthnAlgorithm = typeof WEBAUTHN_ALGORITHMS[number];
export interface WebAuthnApprover {
  kind: 'webauthn';
  /** base64url credential ID. */
  id: string;
  /** base64url SPKI DER from AuthenticatorAttestationResponse.getPublicKey(). */
  publicKey: string;
  alg: WebAuthnAlgorithm;
  rpId: string;
  origin: string;
  label: string;
  createdAt: string;
  signCount: number;
}

const b64url = (b: Buffer) => b.toString('base64url');
export function fromBase64Url(value: unknown, max = 4096): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9_-]+$/.test(value)) throw denied('Malformed WebAuthn field');
  const bytes = Buffer.from(value, 'base64url');
  if (b64url(bytes) !== value) throw denied('Noncanonical WebAuthn field');
  return bytes;
}
function denied(message: string): KakaoError { return new KakaoError('APPROVAL_REQUIRED', message); }
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

/** Domain-separated challenge: an approval can only ever authorize this exact signed text. */
export function approvalChallenge(signingText: string): Buffer {
  return sha256(Buffer.concat([Buffer.from('kakao-approval-v1\0'), Buffer.from(signingText)]));
}
export function rpIdForOrigin(origin: string): string { return new URL(origin).hostname; }

interface AuthData { rpIdHash: Buffer; flags: number; signCount: number; rest: Buffer }
function authData(bytes: Buffer): AuthData {
  if (bytes.length < 37) throw denied('Short authenticator data');
  return { rpIdHash: bytes.subarray(0, 32), flags: bytes[32], signCount: bytes.readUInt32BE(33), rest: bytes.subarray(37) };
}
const UP = 0x01, UV = 0x04, AT = 0x40;
function clientData(bytes: Buffer, type: string, challenge: Buffer, origin: string): void {
  let c: Record<string, unknown>;
  try { c = JSON.parse(bytes.toString('utf8')); } catch { throw denied('Malformed client data'); }
  if (!c || c.type !== type || c.origin !== origin || c.crossOrigin === true || typeof c.challenge !== 'string') throw denied('Client data type, origin or framing mismatch');
  const got = fromBase64Url(c.challenge, 64);
  if (got.length !== challenge.length || !timingSafeEqual(got, challenge)) throw denied('Challenge mismatch');
}
function checkAuth(a: AuthData, rpId: string): void {
  if (!timingSafeEqual(a.rpIdHash, sha256(rpId))) throw denied('Relying party mismatch');
  // User verification (biometric/PIN), not mere presence: browser automation cannot produce it.
  if ((a.flags & UP) === 0 || (a.flags & UV) === 0) throw denied('User verification is required');
}
function publicKey(approver: Pick<WebAuthnApprover, 'publicKey' | 'alg'>): KeyObject {
  let key: KeyObject;
  try { key = createPublicKey({ key: fromBase64Url(approver.publicKey, 2048), format: 'der', type: 'spki' }); }
  catch (cause) { throw new KakaoError('APPROVAL_REQUIRED', 'Unusable approver public key', { cause }); }
  const expected = { [-8]: 'ed25519', [-7]: 'ec', [-257]: 'rsa' }[approver.alg];
  if (key.asymmetricKeyType !== expected || approver.alg === -7 && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      approver.alg === -257 && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw denied('Approver key does not match its algorithm');
  return key;
}

export interface WebAuthnAssertion { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }
/** Verify one assertion for an exact challenge; returns the new signature counter. */
export function verifyWebAuthnAssertion(approver: WebAuthnApprover, challenge: Buffer, assertion: WebAuthnAssertion): number {
  if (assertion.credentialId !== approver.id) throw denied('Unregistered credential');
  const data = fromBase64Url(assertion.authenticatorData), client = fromBase64Url(assertion.clientDataJSON, 8192), signature = fromBase64Url(assertion.signature, 1024);
  const auth = authData(data);
  clientData(client, 'webauthn.get', challenge, approver.origin);
  checkAuth(auth, approver.rpId);
  const signed = Buffer.concat([data, sha256(client)]);
  const ok = verify(approver.alg === -8 ? null : 'sha256', signed, publicKey(approver), signature);
  if (!ok) throw denied('Invalid assertion signature');
  // Authenticators that keep no counter report 0; otherwise a non-increasing value suggests a cloned key.
  if ((auth.signCount !== 0 || approver.signCount !== 0) && auth.signCount <= approver.signCount) throw denied('Authenticator counter did not advance');
  return auth.signCount;
}

export interface WebAuthnRegistration { credentialId: string; publicKey: string; alg: number; clientDataJSON: string; authenticatorData: string }
/** Bind a new credential to an operator-issued enrollment challenge. Attestation is intentionally not trusted. */
export function verifyWebAuthnRegistration(registration: WebAuthnRegistration, challenge: Buffer, origin: string, label: string, now = Date.now()): WebAuthnApprover {
  if (!WEBAUTHN_ALGORITHMS.includes(registration.alg as WebAuthnAlgorithm)) throw denied('Unsupported credential algorithm');
  if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 64 || /[\x00-\x1f\x7f]/.test(label)) throw new KakaoError('INVALID_ARGUMENT', 'A short approver label is required');
  const rpId = rpIdForOrigin(origin), data = fromBase64Url(registration.authenticatorData), id = fromBase64Url(registration.credentialId, 1024);
  clientData(fromBase64Url(registration.clientDataJSON, 8192), 'webauthn.create', challenge, origin);
  const auth = authData(data);
  checkAuth(auth, rpId);
  // Attested credential data: aaguid(16) | idLength(2) | id. The registered ID must be the one the authenticator created.
  if ((auth.flags & AT) === 0 || auth.rest.length < 18 || auth.rest.readUInt16BE(16) !== id.length ||
      !auth.rest.subarray(18, 18 + id.length).equals(id)) throw denied('Credential ID is not attested by the authenticator data');
  const approver: WebAuthnApprover = { kind: 'webauthn', id: registration.credentialId, publicKey: registration.publicKey,
    alg: registration.alg as WebAuthnAlgorithm, rpId, origin, label: label.trim(), createdAt: new Date(now).toISOString(), signCount: auth.signCount };
  publicKey(approver);
  return approver;
}

function parseApprover(x: unknown): WebAuthnApprover {
  const a = x as WebAuthnApprover;
  if (!a || a.kind !== 'webauthn' || typeof a.id !== 'string' || typeof a.publicKey !== 'string' || !WEBAUTHN_ALGORITHMS.includes(a.alg) ||
      typeof a.rpId !== 'string' || typeof a.origin !== 'string' || typeof a.label !== 'string' || typeof a.createdAt !== 'string' ||
      !Number.isSafeInteger(a.signCount) || a.signCount < 0) throw new KakaoError('CONFIG_INVALID', 'Approver registry entry is invalid');
  return a;
}
function ownerOnly(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !isOwnerOnly(stat) || stat.size > 1024 * 1024) throw new Error('Unsafe file');
    return fs.readFileSync(fd);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new KakaoError('CONFIG_INVALID', `Approval file ${path.basename(file)} is unsafe or unreadable`, { cause });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Atomic owner-only replacement; the parent directory is fsynced so a crash cannot lose a registration silently. */
export function writeOwnerOnlyJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}
export function readOwnerOnlyJson(file: string): unknown {
  const bytes = ownerOnly(file);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw new KakaoError('CONFIG_INVALID', `Approval file ${path.basename(file)} is not valid JSON`, { cause }); }
}

/** Operator-controlled list; re-read on every use so a TTY removal takes effect without restart. */
export class ApproverRegistry {
  readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'approvers.json'); }
  list(): WebAuthnApprover[] {
    const raw = readOwnerOnlyJson(this.file);
    if (raw === undefined) return [];
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { approvers?: unknown }).approvers)) throw new KakaoError('CONFIG_INVALID', 'Approver registry is invalid');
    return (raw as { approvers: unknown[] }).approvers.map(parseApprover);
  }
  get(id: string): WebAuthnApprover | undefined { return this.list().find(a => a.id === id); }
  private save(approvers: WebAuthnApprover[]): void { writeOwnerOnlyJson(this.file, { version: 1, approvers }); }
  add(approver: WebAuthnApprover): void {
    const all = this.list();
    if (all.some(a => a.id === approver.id)) throw new KakaoError('IDEMPOTENCY_CONFLICT', 'This credential is already registered');
    if (all.length >= 20) throw new KakaoError('POLICY_DENIED', 'Approver registry is full');
    this.save([...all, parseApprover(approver)]);
  }
  remove(id: string): boolean {
    const all = this.list(), next = all.filter(a => a.id !== id);
    if (next.length === all.length) return false;
    this.save(next); return true;
  }
  updateSignCount(id: string, signCount: number): void {
    this.save(this.list().map(a => a.id === id ? { ...a, signCount } : a));
  }
}

export type ApprovalState = 'approved' | 'rejected';
export interface ApprovalEvent { requestId: string; state: ApprovalState }

/**
 * Durable record that an approver verified one exact envelope. Only an HMAC of the signed text,
 * the approver ID and time are stored; the draft and the assertion are not.
 */
export class ApprovalStore {
  private readonly journal: AgentSendJournal;
  private readonly registry: ApproverRegistry;
  private readonly now: () => number;
  readonly events = new EventEmitter();
  /** Whether confirmations from an MCP client's own dialog (elicitation) count as approval. */
  private readonly clientConfirmations: boolean;
  constructor(journal: AgentSendJournal, registry: ApproverRegistry, now: () => number = Date.now, opts: { clientConfirmations?: boolean } = {}) {
    this.journal = journal; this.registry = registry; this.now = now;
    this.clientConfirmations = opts.clientConfirmations === true;
    this.events.setMaxListeners(100);
  }
  configured(): boolean { return this.clientConfirmations || this.registry.list().length > 0; }
  /** HMAC that binds an approval to one exact signed text. */
  envelopeDigest(signingText: string): string { return this.journal.digest({ approval: signingText }); }
  /**
   * Record a confirmation the human gave in the MCP client's own dialog. The transport proves the dialog
   * was for this digest (sealed requestState); trust rests on the client showing it to a person, not the model.
   */
  recordClientConfirmation(requestId: string, envelopeDigest: string, client: string): void {
    if (!this.clientConfirmations) throw denied('Client confirmations are disabled; use the passkey approval page');
    const row = this.journal.get(requestId);
    if (!row || row.state !== 'prepared') throw denied('Only a prepared operation awaiting approval can be approved');
    if (row.expires_at <= this.now()) throw new KakaoError('OPERATION_EXPIRED', 'Operation expired before approval');
    if (!/^[a-z0-9._-]{1,64}$/.test(client)) throw denied('Invalid client identity');
    this.journal.db.transaction(() => {
      this.journal.db.db.prepare('INSERT INTO agent_approvals (request_id, envelope_digest, approver_id, verified_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(request_id) DO UPDATE SET envelope_digest = excluded.envelope_digest, approver_id = excluded.approver_id, verified_at = excluded.verified_at')
        .run(requestId, envelopeDigest, `client:${client}`, this.now());
    });
    this.events.emit('change', { requestId, state: 'approved' } satisfies ApprovalEvent);
  }
  /** Verify a passkey assertion against the exact prepared text, then persist the approval. */
  approve(requestId: string, signingText: string, assertion: WebAuthnAssertion): { approverId: string } {
    const row = this.journal.get(requestId);
    if (!row || row.state !== 'prepared') throw denied('Only a prepared operation awaiting approval can be approved');
    if (row.expires_at <= this.now()) throw new KakaoError('OPERATION_EXPIRED', 'Operation expired before approval');
    const approver = this.registry.get(assertion.credentialId);
    if (!approver) throw denied('Unregistered credential');
    const signCount = verifyWebAuthnAssertion(approver, approvalChallenge(signingText), assertion);
    this.registry.updateSignCount(approver.id, signCount);
    this.journal.db.transaction(() => {
      this.journal.db.db.prepare('INSERT INTO agent_approvals (request_id, envelope_digest, approver_id, verified_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(request_id) DO UPDATE SET envelope_digest = excluded.envelope_digest, approver_id = excluded.approver_id, verified_at = excluded.verified_at')
        .run(requestId, this.journal.digest({ approval: signingText }), approver.id, this.now());
    });
    this.events.emit('change', { requestId, state: 'approved' } satisfies ApprovalEvent);
    return { approverId: approver.id };
  }
  /** Refusal narrows authority, so it needs no user verification. */
  reject(requestId: string): void {
    const row = this.journal.get(requestId);
    // Only before any commit began: an `approved` row is already inside a commit and must not be raced.
    if (!row || row.state !== 'prepared' || !this.journal.transition(requestId, 'prepared', 'rejected')) {
      throw new KakaoError('INVALID_ARGUMENT', 'Only a pending operation can be rejected');
    }
    this.events.emit('change', { requestId, state: 'rejected' } satisfies ApprovalEvent);
  }
  /** Verification time of a stored approval of this exact text by an approver that is still registered. */
  approvalTime(requestId: string, signingText: string): number | undefined {
    const row = this.journal.db.db.prepare('SELECT envelope_digest, approver_id, verified_at FROM agent_approvals WHERE request_id = ?').get(requestId) as { envelope_digest: string; approver_id: string; verified_at: number } | undefined;
    if (!row || row.envelope_digest !== this.journal.digest({ approval: signingText })) return undefined;
    // Client confirmations count only while enabled; passkey approvals only while the passkey stays registered.
    if (row.approver_id.startsWith('client:') ? !this.clientConfirmations : !this.registry.get(row.approver_id)) return undefined;
    return row.verified_at;
  }
  /** Content-free lifecycle for wait_for_approval. */
  state(requestId: string): string {
    const row = this.journal.get(requestId);
    if (!row) throw new KakaoError('NOT_FOUND', 'No operation with this request ID');
    if (row.state === 'prepared') {
      const approved = this.journal.db.db.prepare('SELECT verified_at FROM agent_approvals WHERE request_id = ?').get(requestId) as { verified_at: number } | undefined;
      if (approved) return approved.verified_at + COMMIT_WINDOW_MS <= this.now() ? 'expired' : 'approved';
      return row.expires_at <= this.now() ? 'expired' : 'awaiting_approval';
    }
    return row.state === 'sending' ? 'outcome_unknown' : row.state;
  }
}
