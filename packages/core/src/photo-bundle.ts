import type { PhotoUploadItem } from '@kakao-max/protocol';
import { KakaoError } from './errors.ts';

/** Read actual dimensions from PNG IHDR / JPEG SOF; never trust caller-supplied dimensions. */
export function preparePhotoBundle(data: readonly Uint8Array[]): PhotoUploadItem[] {
  if (!Array.isArray(data) || data.length < 2 || data.length > 30 ||
      data.some(b => !(b instanceof Uint8Array) || b.length === 0 || b.length > 16 * 1024 * 1024) ||
      data.reduce((n, b) => n + b.length, 0) > 16 * 1024 * 1024) {
    throw new KakaoError('INVALID_ARGUMENT', 'Select 2–30 JPEG/PNG photos with at most 16 MiB total');
  }
  return data.map(preparePhoto);
}

export function preparePhoto(bytes: Uint8Array): PhotoUploadItem {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 16 * 1024 * 1024) throw new KakaoError('INVALID_ARGUMENT', 'Photo size must be 1 byte to 16 MiB');
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, ext: 'jpg' | 'png' = 'jpg';
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
    ext = 'png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p < b.length && b[p] === 0xff) {
      while (p < b.length && b[p] === 0xff) p++;
      if (p >= b.length) break;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) break;
      const length = b.readUInt16BE(p);
      if (length < 2 || p + length > b.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += length;
    }
  }
  if (!width || !height || width > 65535 || height > 65535) {
    throw new KakaoError('INVALID_ARGUMENT', 'Each photo must have a supported JPEG/PNG dimension header');
  }
  return { data: bytes, width, height, ext };
}
