import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocoError } from '@kakao-max/protocol';
import { toKakaoError } from './errors.ts';
import { preparePhotoBundle } from './photo-bundle.ts';

test('bundle derives PNG/JPEG dimensions and rejects malformed or oversized inputs before allocation', () => {
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  const jpg = Buffer.from([255,216,255,224,0,4,0,0,255,192,0,8,8,0,100,0,200,1]);
  const items = preparePhotoBundle([png, jpg]);
  assert.deepEqual(items.map(i => [i.width, i.height, i.ext]), [[640,480,'png'], [200,100,'jpg']]);
  for (const data of [[png], [png, Buffer.alloc(0)], [png, jpg.subarray(0, 14)],
    [png, Buffer.alloc(16 * 1024 * 1024)], Array.from({ length: 31 }, () => png)]) {
    assert.throws(() => preparePhotoBundle(data));
  }
});


test('ambiguous bundle publication is not an automatically retryable send', () => {
  const error = toKakaoError(new LocoError('AMBIGUOUS_WRITE', 'synthetic lost response', { command: 'WRITE' }));
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN'); assert.equal(error.retryable, false);
});
