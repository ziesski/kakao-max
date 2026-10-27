import crypto from 'node:crypto';
import { LocoError } from '../errors/loco-error.js';
import { buildMultiPhotoExtra } from './loco-parse.js';
import type { MultiPhotoShipResult, WriteResult } from './loco-session.js';

export interface PhotoUploadItem {
  data: Uint8Array;
  width: number;
  height: number;
  ext: 'jpg' | 'png';
}

/** MSHIP allocates per-item tokens; trailer MPOST uploads each; one WRITE publishes the bundle. */
export async function uploadPhotoBundle(deps: {
  ship: (items: Array<{ size: number; checksum: string; ext: string }>) => Promise<MultiPhotoShipResult>;
  upload: (item: PhotoUploadItem, allocation: { host: string; port: number; token: string }) => Promise<void>;
  publish: (extra: string) => Promise<WriteResult>;
  beforeStep?: () => void;
}, items: readonly PhotoUploadItem[]) {
  if (!Array.isArray(items) || items.length < 2 || items.length > 30 || items.some(i =>
    !(i.data instanceof Uint8Array) || i.data.length === 0 || i.data.length > 16 * 1024 * 1024 ||
    !['jpg', 'png'].includes(i.ext) || !Number.isSafeInteger(i.width) || i.width < 1 || i.width > 65535 ||
    !Number.isSafeInteger(i.height) || i.height < 1 || i.height > 65535) ||
    items.reduce((n, i) => n + i.data.length, 0) > 16 * 1024 * 1024) {
    throw new LocoError('INVALID_ARGUMENT', 'Select 2–30 JPEG/PNG photos, positive dimensions and at most 16 MiB total');
  }
  const metadata = items.map(i => ({ size: i.data.length, checksum: crypto.createHash('sha1').update(i.data).digest('hex'), ext: i.ext }));
  deps.beforeStep?.();
  const ship = await deps.ship(metadata);
  if (ship.status !== 0) throw new LocoError('STATUS', 'MSHIP rejected the photo bundle', { command: 'MSHIP', status: ship.status });
  const lists = [ship.tokenList, ship.portList, ship.v2slHostList, ship.mimeTypeList];
  if (lists.some(list => !Array.isArray(list) || list.length !== items.length) ||
      new Set(ship.tokenList).size !== items.length || ship.tokenList.some(t => typeof t !== 'string' || !t) ||
      ship.portList.some(p => !Number.isInteger(p) || p < 1 || p > 65535) ||
      ship.v2slHostList.some(h => typeof h !== 'string' || !h || /[\s/:@]/.test(h)) ||
      ship.mimeTypeList.some((m, i) => !(items[i].ext === 'jpg' ? ['image/jpeg', 'image/jpg'] : ['image/png']).includes(m))) {
    throw new LocoError('MALFORMED', 'MSHIP returned an incomplete or unsupported item allocation', { command: 'MSHIP' });
  }
  for (let i = 0; i < items.length; i++) {
    deps.beforeStep?.();
    await deps.upload(items[i], { host: ship.v2slHostList[i], port: ship.portList[i], token: ship.tokenList[i] });
  }
  const extra = buildMultiPhotoExtra(items.map((item, i) => ({ token: ship.tokenList[i], width: item.width,
    height: item.height, size: metadata[i].size, checksum: metadata[i].checksum, mimeType: ship.mimeTypeList[i] })));
  deps.beforeStep?.();
  // No retry: a lost WRITE response may already have published the bundle.
  let result: WriteResult;
  try { result = await deps.publish(extra); }
  catch { throw new LocoError('AMBIGUOUS_WRITE', 'Bundle publication response was lost; check history before any retry', { command: 'WRITE' }); }
  if (result.status !== 0) throw new LocoError('STATUS', 'WRITE rejected the photo bundle', { command: 'WRITE', status: result.status });
  if (!result.logId) throw new LocoError('AMBIGUOUS_WRITE', 'Bundle publication has no confirmed log ID; do not automatically retry', { command: 'WRITE' });
  return { ...result, extra, photoCount: items.length };
}
