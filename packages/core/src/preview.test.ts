import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewText } from './preview.ts';

test('previewText keeps plain text and collapses whitespace', () => {
  assert.equal(previewText('안녕\n하세요  ', 1), '안녕 하세요');
  assert.equal(previewText('reply body', 26), 'reply body');
});

test('previewText labels VoIP signalling by event', () => {
  assert.equal(previewText('{ "type":"canceled","csIP":"1.2.3.4"}', 51), '[통화 취소]');
  assert.equal(previewText('{ "type":"bye"}', 51), '[통화 종료]');
  assert.equal(previewText('not json', 51), '[통화]');
});

test('previewText labels media and drops placeholder bodies', () => {
  assert.equal(previewText('photo', 2), '[사진]');
  assert.equal(previewText('사진 28장', 27), '[사진 묶음] 사진 28장');
  assert.equal(previewText('{"inviter":{}}', 0), '[알림]');
  assert.equal(previewText('{"x":1}', 99), '[type 99]');
});
