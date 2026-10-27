import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { uploadPhotoBundle } from './multi-photo.js';

test('bundle preserves item ordering and publishes one WRITE only after all item completions', async () => {
  const items = [1, 2].map(n => ({ data: Buffer.from(`synthetic ${n}`), width: n * 10, height: n * 20, ext: 'jpg' as const }));
  const calls: string[] = [];
  const result = await uploadPhotoBundle({ ship: async metadata => {
    calls.push('MSHIP');
    assert.equal(metadata[0].checksum, createHash('sha1').update(items[0].data).digest('hex'));
    return { status: 0, tokenList: ['first', 'second'], portList: [995, 995], v2slHostList: ['a.example', 'b.example'],
      v2slHost6List: [], mimeTypeList: ['image/jpg', 'image/jpeg'], raw: {} };
  }, upload: async (item, allocation) => {
    calls.push(allocation.token); assert.equal(item, items[calls.length - 2]);
  }, publish: async extra => {
    calls.push('WRITE'); const a = JSON.parse(extra);
    assert.deepEqual(a.mtl, ['image/jpg', 'image/jpeg']); assert.deepEqual(a.kl, ['first', 'second']); assert.deepEqual(a.wl, [10, 20]);
    assert.deepEqual(a.sl, items.map(i => i.data.length));
    return { status: 0, logId: '9007199254740993', raw: {} };
  } }, items);
  assert.deepEqual(calls, ['MSHIP', 'first', 'second', 'WRITE']);
  assert.equal(result.photoCount, 2); assert.equal(result.logId, '9007199254740993');
});

test('invalid allocation, item failure, pause and ambiguous publication never trigger fallback or retry', async () => {
  const items = [1, 2].map(n => ({ data: Buffer.from([n]), width: 1, height: 1, ext: 'png' as const }));
  const allocation = { status: 0, tokenList: ['a', 'b'], portList: [995, 995], v2slHostList: ['a.example', 'b.example'],
    v2slHost6List: [], mimeTypeList: ['image/png', 'image/png'], raw: {} };
  for (const mode of ['short', 'duplicate', 'mime', 'status', 'upload', 'pause', 'publish']) {
    let uploads = 0, writes = 0, steps = 0;
    await assert.rejects(uploadPhotoBundle({
      ship: async () => ({ ...allocation, ...(mode === 'short' ? { portList: [995] } : {}),
        ...(mode === 'duplicate' ? { tokenList: ['a', 'a'] } : {}), ...(mode === 'mime' ? { mimeTypeList: ['', ''] } : {}),
        ...(mode === 'status' ? { status: -500 } : {}) }),
      upload: async () => { uploads++; if (mode === 'upload') throw new Error('synthetic item failure'); },
      beforeStep: () => { steps++; if (mode === 'pause' && steps === 4) throw new Error('synthetic pause'); },
      publish: async () => { writes++; throw new Error('synthetic lost response'); }
    }, items));
    assert.equal(writes, mode === 'publish' ? 1 : 0);
    if (['short', 'duplicate', 'mime', 'status'].includes(mode)) assert.equal(uploads, 0);
    if (mode === 'upload') assert.equal(uploads, 1);
  }
});
