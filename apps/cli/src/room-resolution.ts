import { KakaoError } from '@kakao-max/core';

/** Resolve only already-known rooms. Lookup never creates a room or contacts a server. */
export function resolveRoom<T extends { id: string; type?: string; title?: string }>(chats: T[], query: string): T | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return;
  const exactId = chats.find(c => c.id === query.trim());
  if (exactId) return exactId;
  const unique = (matches: T[]) => {
    if (matches.length > 1) throw new KakaoError('INVALID_ARGUMENT', 'Ambiguous room; use its exact canonical ID');
    return matches[0];
  };
  if (['self','me','나','나와의채팅'].includes(q)) return unique(chats.filter(c => c.type === 'MemoChat'));
  if (/^#?[1-9]\d*$/.test(q)) {
    const index = Number(q.replace(/^#/, ''));
    return Number.isSafeInteger(index) ? chats[index - 1] : undefined;
  }
  const exact = chats.filter(c => c.title?.toLowerCase() === q);
  if (exact.length) return unique(exact);
  return unique(chats.filter(c => c.title?.toLowerCase().includes(q)));
}
