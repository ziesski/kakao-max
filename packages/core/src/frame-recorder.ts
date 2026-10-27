// ----------------------------------------------------------------------------
// Sanitizing LOCO packet recorder for replay-test fixtures.
//
// Enabled only when KAKAO_RECORD_FILE is set. Every packet is sanitized BEFORE it
// is written, so raw content never touches disk:
//   - strings: replaced by "s:<length>" unless they are chat-type codes
//     ("DirectChat", "MultiChat", "OM", …); this covers message text, names, URLs,
//     tokens, device ids and embedded JSON
//   - log-like ids (logId, prevId, lastTokenId, watermark, cur, max, …):
//     shifted down by a random per-recording offset, so ordering and differences
//     (paging, unread logic) survive but absolute values do not
//   - other large numbers (user ids, chat ids, account ids): replaced through a
//     keyed hash with a per-recording secret, so the same id maps to the same
//     fake id within one recording (relationships survive) but cannot be reversed
//   - timestamps (sendAt, s, …): shifted by a random number of days, so ordering
//     survives but real send times do not
//   - small numbers, booleans, null, and object keys: kept (they are structure);
//     numeric object keys (maps keyed by id) are hashed like ids
// The secret and offsets live only in memory and are discarded on exit.
// ----------------------------------------------------------------------------

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { LocoFrame } from '@kakao-max/protocol';

/** Keys whose numeric value is a time-ordered LOCO log id. */
const LOG_ID_KEYS = new Set([
  'logId', 'prevId', 'lastLogId', 'lastTokenId', 'watermark', 'cur', 'max', 'minLogId',
  'll', 'ls', 'lastSeenLogId', 'lastReadLogId'
]);
/** Keys whose numeric value is a unix timestamp in seconds. */
const TIME_KEYS = new Set(['sendAt', 's', 'createdAt', 'lastSendAt', 'ts', 'lastUpdatedAt', 'joinTime']);
/** The only strings kept verbatim: chat-type codes (see chat-types.ts). */
const ENUM_STRING = /^(?:[A-Z][A-Za-z]{1,20}Chat|OM|OD)$/;
/**
 * Keys whose number is always an identifier, however small (early accounts have
 * short user ids): `…Id`, `…Ids`, `id`, and LOGINLIST's `c` (chat) / `i` (members).
 */
const ID_KEY = /(?:Id|Ids)$|^(?:id|c|i|k)$/;
/** Below this, a number under any other key is a count, type, status or flag. */
const ID_THRESHOLD = 1_000_000;

export interface Sanitizer {
  (value: unknown, key?: string): unknown;
}

export function createSanitizer(
  secret: Buffer = crypto.randomBytes(32),
  logOffset?: bigint,
  timeOffsetSec?: number
): Sanitizer {
  // Random offset in [2^30, 2^40): keeps logIds (~2^61) positive and ordered.
  const offset = logOffset ?? (BigInt('0x' + crypto.randomBytes(5).toString('hex')) | (1n << 30n));
  // 1-365 whole days, so time-of-day patterns stay plausible but dates do not.
  const timeShift = timeOffsetSec ?? (1 + crypto.randomInt(365)) * 86_400;

  const fakeId = (digits: string): string => {
    const h = crypto.createHmac('sha256', secret).update(digits).digest();
    // Same digit count as the original, never starting with 0.
    let out = String(1 + (h[0] % 9));
    for (let i = 1; out.length < digits.length; i++) out += String(h[i % h.length] % 10);
    return out;
  };

  const sanitize: Sanitizer = (value, key) => {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'string') return ENUM_STRING.test(value) ? value : `s:${value.length}`;
    // BSON Long / bigint / number: normalize to a decimal string first.
    const isLong = typeof value === 'object' && value !== null && (value as any)._bsontype === 'Long';
    if (typeof value === 'number' || typeof value === 'bigint' || isLong) {
      const digits = String(value);
      if (!/^-?\d+$/.test(digits)) return typeof value === 'number' ? value : digits; // floats are not ids
      const n = BigInt(digits);
      const abs = n < 0n ? -n : n;
      const small = abs < BigInt(ID_THRESHOLD);
      if (key && LOG_ID_KEYS.has(key)) {
        // Small values here are sentinels (cur: 0 = "from the start"), not real log ids.
        return small ? (typeof value === 'number' ? value : digits) : (n - offset).toString();
      }
      if (small && !(key !== undefined && ID_KEY.test(key))) return typeof value === 'number' ? value : digits;
      if (key && TIME_KEYS.has(key) && typeof value === 'number') return value - timeShift;
      return (n < 0n ? '-' : '') + fakeId(abs.toString());
    }
    if (value instanceof Uint8Array || (typeof value === 'object' && (value as any)._bsontype === 'Binary')) {
      return 'bin';
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v, key));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[/^\d{6,}$/.test(k) ? fakeId(k) : k] = sanitize(v, k);
      }
      return out;
    }
    return `s:?`;
  };
  return sanitize;
}

/** An onFrame handler appending sanitized frames as JSON lines to `file` (0600). */
export function createFrameRecorder(file: string, log: (line: string) => void): (frame: LocoFrame) => void {
  const sanitize = createSanitizer();
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  fs.chmodSync(file, 0o600);
  log('recording sanitized LOCO frames');
  return (frame) => {
    const line = JSON.stringify({
      dir: frame.direction,
      id: frame.id,
      method: frame.method,
      status: frame.status,
      ...(frame.response !== undefined ? { response: frame.response } : {}),
      body: sanitize(frame.body)
    });
    fs.appendFileSync(file, line + '\n');
  };
}
