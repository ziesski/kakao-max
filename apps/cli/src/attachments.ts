import { KakaoError } from '@kakao-max/core';

/** download_attachment media types (see its schema): photo=2, video=3, audio=5, file=18. */
export const MEDIA_TYPES: Record<string, number> = { photo: 2, video: 3, audio: 5, file: 18 };
const MEDIA_NAMES = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([name, code]) => [code, name]));

/** --type accepts a name or its numeric code; absent means photo. */
export function parseMediaType(raw: string | undefined): number {
  if (raw === undefined) return MEDIA_TYPES.photo;
  const code = MEDIA_TYPES[raw.toLowerCase()] ?? Number(raw);
  if (!MEDIA_NAMES[code]) throw new KakaoError('INVALID_ARGUMENT', `--type must be one of ${Object.keys(MEDIA_TYPES).join(', ')} (or 2, 3, 5, 18)`);
  return code;
}

export function mediaTypeName(code: number): string {
  return MEDIA_NAMES[code] ?? String(code);
}

function parse(attachment: unknown): Record<string, any> | undefined {
  if (attachment && typeof attachment === 'object') return attachment as Record<string, any>;
  if (typeof attachment !== 'string' || !attachment.trim().startsWith('{')) return;
  try { return JSON.parse(attachment); } catch { return; }
}

/**
 * Downloadable media in one stored message: the token(s) and the download type for each.
 * A multi-photo message (27) carries one token per photo in `kl`.
 */
export function messageAttachments(m: { type?: number; attachment?: unknown }): Array<{ token: string; type: number }> {
  const att = parse(m.attachment);
  if (!att) return [];
  if (m.type === 27 && Array.isArray(att.kl)) {
    return att.kl.filter((k: unknown): k is string => typeof k === 'string' && k !== '').map((token: string) => ({ token, type: MEDIA_TYPES.photo }));
  }
  if (typeof att.k !== 'string' || !att.k || m.type === undefined || !MEDIA_NAMES[m.type]) return [];
  return [{ token: att.k, type: m.type }];
}
