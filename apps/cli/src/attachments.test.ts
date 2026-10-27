import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAttachments, mediaTypeName, parseMediaType } from './attachments.ts';

test('--type accepts names and download codes, defaults to photo and rejects anything else', () => {
  assert.equal(parseMediaType(undefined), 2);
  assert.equal(parseMediaType('file'), 18);
  assert.equal(parseMediaType('VIDEO'), 3);
  assert.equal(parseMediaType('5'), 5);
  for (const bad of ['27', 'sticker', '', '0']) assert.throws(() => parseMediaType(bad), { code: 'INVALID_ARGUMENT' });
  assert.equal(mediaTypeName(18), 'file');
});

test('stored attachments yield the token and download type that history prints', () => {
  assert.deepEqual(messageAttachments({ type: 18, attachment: '{"k":"fixture-file-token","name":"fixture.bin"}' }), [{ token: 'fixture-file-token', type: 18 }]);
  assert.deepEqual(messageAttachments({ type: 3, attachment: { k: 'fixture-video-token' } }), [{ token: 'fixture-video-token', type: 3 }]);
  assert.deepEqual(messageAttachments({ type: 27, attachment: '{"kl":["fixture-a","fixture-b",""]}' }),
    [{ token: 'fixture-a', type: 2 }, { token: 'fixture-b', type: 2 }]);
});

test('text, emoticons and malformed attachments offer no download', () => {
  assert.deepEqual(messageAttachments({ type: 1 }), []);
  assert.deepEqual(messageAttachments({ type: 12, attachment: '{"k":"fixture-emoticon"}' }), []);
  assert.deepEqual(messageAttachments({ type: 2, attachment: '{not json' }), []);
  assert.deepEqual(messageAttachments({ type: 2, attachment: '{"k":""}' }), []);
});
