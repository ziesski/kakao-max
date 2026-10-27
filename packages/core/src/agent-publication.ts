// Immutable binary/forward operations share the text journal, policy and claim boundary.
import { createHash } from 'node:crypto';
import { AgentOperationService, canonicalAgentJson, type AgentOperationAdapter, type AgentSendJournal, type StoredApprovals, type RoomSendApprovals, type ApprovalWindow } from './agent-send.ts';
import { preparePhoto, preparePhotoBundle } from './photo-bundle.ts';
import { KakaoError } from './errors.ts';
import type { SendPolicy } from './policy.ts';

export type AgentPublicationAction = 'send_media' | 'send_photo_bundle' | 'forward_message';
export interface AgentPublicationInput {
  chatId: string; dataBase64?: string; type?: number; fileName?: string; width?: number; height?: number;
  photos?: string[]; text?: string; extra?: string;
}
export interface AgentPublicationDescriptor {
  chatId: string; type?: number; fileName?: string; size?: number; sha256?: string; width?: number; height?: number; ext?: string;
  photos?: Array<{ size: number; sha256: string; width: number; height: number; ext: string }>;
  text?: string; extra?: string;
}
export interface AgentPublicationSnapshot { descriptor: AgentPublicationDescriptor; buffers: Buffer[]; dispose(): void; }
const LIMIT = 16 * 1024 * 1024;
function fail(): never { throw new KakaoError('INVALID_ARGUMENT', 'Invalid bounded publication payload; use exact room IDs and inline bytes, never daemon file paths'); }
function fields(input: AgentPublicationInput, allowed: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) ||
      typeof input.chatId !== 'string' || !/^[1-9]\d{0,18}$/.test(input.chatId) || BigInt(input.chatId) > 9223372036854775807n) fail();
}
function decode(value: unknown): Buffer {
  // Bound before decoding. Re-encoding rejects noncanonical padding and unused bits.
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(LIMIT / 3) * 4 ||
      value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail();
  const b = Buffer.from(value, 'base64');
  if (!b.length || b.length > LIMIT || b.toString('base64') !== value) { b.fill(0); fail(); }
  return b;
}
function digest(b: Buffer) { return { size: b.length, sha256: createHash('sha256').update(b).digest('hex') }; }
/** Own an invocation snapshot; all validation failures and callers must wipe decoded bytes. */
export function normalizeAgentPublication(action: AgentPublicationAction, raw: AgentPublicationInput): AgentPublicationSnapshot {
  const buffers: Buffer[] = [];
  const dispose = () => { for (const bytes of buffers) bytes.fill(0); };
  try {
    let descriptor: AgentPublicationDescriptor;
    if (action === 'forward_message') {
      fields(raw, ['chatId','text','type','extra']);
      if (typeof raw.text !== 'string' || !raw.text.trim() || Buffer.byteLength(raw.text) > 4000 ||
          raw.type !== undefined && (!Number.isSafeInteger(raw.type) || raw.type < 1 || raw.type > 255) ||
          raw.extra !== undefined && (typeof raw.extra !== 'string' || Buffer.byteLength(raw.extra) > 32768)) fail();
      descriptor = { chatId: raw.chatId, text: raw.text, type: raw.type ?? 1, ...(raw.extra !== undefined ? { extra: raw.extra } : {}) };
    } else if (action === 'send_media') {
      fields(raw, ['chatId','dataBase64','type','fileName','width','height']);
      const type = raw.type ?? 2;
      if (![2,3,5,18].includes(type) || typeof raw.fileName !== 'string' || !raw.fileName.length ||
          Buffer.byteLength(raw.fileName) > 255 || /[\x00-\x1f\x7f/\\]/.test(raw.fileName)) fail();
      const data = decode(raw.dataBase64); buffers.push(data);
      descriptor = { chatId: raw.chatId, type, fileName: raw.fileName, ...digest(data) };
      if (type === 2) {
        const photo = preparePhoto(data);
        if (raw.width !== undefined && raw.width !== photo.width || raw.height !== undefined && raw.height !== photo.height) fail();
        descriptor = { ...descriptor, width: photo.width, height: photo.height, ext: photo.ext };
      } else if (raw.width !== undefined || raw.height !== undefined) fail();
    } else if (action === 'send_photo_bundle') {
      fields(raw, ['chatId','photos']);
      if (!Array.isArray(raw.photos) || raw.photos.length < 2 || raw.photos.length > 30 ||
          raw.photos.some(s => typeof s !== 'string') || raw.photos.reduce((n, s) => n + s.length, 0) > Math.ceil(LIMIT / 3) * 4 + 120) fail();
      for (const encoded of raw.photos) buffers.push(decode(encoded));
      const photos = preparePhotoBundle(buffers);
      descriptor = { chatId: raw.chatId, photos: photos.map((p, i) => ({ ...digest(buffers[i]), width: p.width, height: p.height, ext: p.ext! })) };
    } else return fail();
    return { descriptor, buffers, dispose };
  } catch (error) { dispose(); throw error; }
}
export function agentPublicationDomain(action: AgentPublicationAction): string { return `agent-publication-v1:${action}`; }

export interface AgentPublicationAdapter extends Omit<AgentOperationAdapter<AgentPublicationDescriptor>, 'send'> {
  send(action: AgentPublicationAction, snapshot: AgentPublicationSnapshot): Promise<{ status: number; logId?: string }>;
}
export class AgentPublicationService {
  private readonly deps: { principal: string; journal: AgentSendJournal; policy: SendPolicy; approvals?: StoredApprovals; approvalWindow?: ApprovalWindow; recipients?: RoomSendApprovals; now?: () => number; modeApproves?: (action: string) => boolean; adapter: AgentPublicationAdapter; notifications?: boolean };
  constructor(deps: AgentPublicationService['deps']) { this.deps = deps; }
  private service(action: AgentPublicationAction, snapshot: AgentPublicationSnapshot) {
    return new AgentOperationService({ ...this.deps, adapter: { ...this.deps.adapter,
      send: async descriptor => {
        // The adapter can only receive the bytes from this validated invocation.
        if (canonicalAgentJson(descriptor) !== canonicalAgentJson(snapshot.descriptor)) throw new KakaoError('INTERNAL', 'Publication snapshot changed');
        return this.deps.adapter.send(action, snapshot);
      } }, definition: { domain: agentPublicationDomain(action), action,
        parse: (input: AgentPublicationDescriptor) => JSON.parse(canonicalAgentJson(input)) as AgentPublicationDescriptor,
        textLength: input => input.text?.length ?? 0,
        // Bundles previously required explicit approval even at the notification destination.
        requireSignature: action === 'send_photo_bundle' } });
  }
  prepare(action: AgentPublicationAction, id: string, input: AgentPublicationInput) {
    const snapshot = normalizeAgentPublication(action, input);
    try { return this.service(action, snapshot).prepare(id, snapshot.descriptor); }
    finally { snapshot.dispose(); }
  }
  async send(action: AgentPublicationAction, id: string, input: AgentPublicationInput) {
    const snapshot = normalizeAgentPublication(action, input);
    try { return await this.service(action, snapshot).send(id, snapshot.descriptor); }
    finally { snapshot.dispose(); }
  }
}
