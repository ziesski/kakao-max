import { KakaoError } from './errors.ts';

export interface HistoryRangeOptions { from: string; to: string; cursor?: string; limit?: number }
export interface HistoryRangeState {
  chatId: string; from: string; to: string; max: string; phase: 'sync' | 'local';
  since: string; pages: number; truncated: boolean; before?: { sendAt: number; logId: string };
}
const invalid = () => new KakaoError('INVALID_ARGUMENT', 'Use an exact room, offset-qualified from/to, limit 1–100, and the returned range cursor unchanged');
const id = (s: unknown): s is string => typeof s === 'string' && /^\d{1,19}$/.test(s) && BigInt(s) <= 9223372036854775807n;
const date = (s: unknown): number => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) throw invalid();
  const [year, month, day, hour, minute, second] = s.slice(0, 19).split(/[-T:]/).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59) throw invalid();
  const n = Date.parse(s);
  if (!Number.isFinite(n) || n % 1000 !== 0) throw invalid();
  return n / 1000;
};
export function historyRangeCursor(state: HistoryRangeState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}
export function parseHistoryRange(chatId: string, opts: HistoryRangeOptions, max: string) {
  const from = date(opts.from), to = date(opts.to), limit = opts.limit ?? 100;
  if (!id(chatId) || !id(max) || from >= to || to - from > 31 * 86400 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  let state: HistoryRangeState = { chatId, from: opts.from, to: opts.to, max, phase: 'sync', since: '0', pages: 0, truncated: false };
  if (opts.cursor !== undefined) {
    if (typeof opts.cursor !== 'string' || opts.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(opts.cursor)) throw invalid();
    let c: HistoryRangeState;
    try { c = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (!c || c.chatId !== chatId || c.from !== opts.from || c.to !== opts.to || !id(c.max) || !id(c.since) || BigInt(c.since) > BigInt(c.max) ||
      !['sync', 'local'].includes(c.phase) || !Number.isInteger(c.pages) || c.pages < 0 || c.pages > 20 ||
      (c.phase === 'sync' && c.pages >= 20) || typeof c.truncated !== 'boolean' ||
      (c.before && (c.phase !== 'local' || !Number.isSafeInteger(c.before.sendAt) || c.before.sendAt < from || c.before.sendAt >= to || !id(c.before.logId) || BigInt(c.before.logId) > BigInt(c.max)))) throw invalid();
    state = c;
  }
  return { from, to, limit, state };
}
