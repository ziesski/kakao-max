import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createLocoV2Handshake, encryptLocoV2Frame, decryptLocoV2Frame } from './loco-crypto.js';

test('LocoV2Handshake structure and key length', () => {
  const { handshakeBytes, aesKey } = createLocoV2Handshake();
  assert.equal(handshakeBytes.length, 268);
  assert.equal(aesKey.length, 16);

  const view = new DataView(handshakeBytes.buffer, handshakeBytes.byteOffset, handshakeBytes.byteLength);
  assert.equal(view.getUint32(0, true), 256); // Key length
  assert.equal(view.getUint32(4, true), 0x10); // RSA OAEP SHA-1
  assert.equal(view.getUint32(8, true), 0x03); // AES-128-GCM
});

test('LocoV2SL Encrypt and Decrypt Roundtrip', () => {
  const aesKey = crypto.randomBytes(16);
  const plainText = new TextEncoder().encode('Hello KakaoTalk LOCO Protocol V2!');

  const frame = encryptLocoV2Frame(plainText, aesKey);
  // Total length = 4 (frame len) + 12 (IV) + plainText.length + 16 (Tag)
  assert.equal(frame.length, 4 + 12 + plainText.length + 16);

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const declaredLength = view.getUint32(0, true);
  assert.equal(declaredLength, 12 + plainText.length + 16);

  const bodyData = frame.subarray(4);
  const decrypted = decryptLocoV2Frame(bodyData, aesKey);
  assert.deepEqual(decrypted, plainText);
});

test('LocoV2SL Decrypt detects tampered ciphertext', () => {
  const aesKey = crypto.randomBytes(16);
  const plainText = new TextEncoder().encode('Sensitive chat message');
  const frame = encryptLocoV2Frame(plainText, aesKey);

  // Tamper with one byte in the ciphertext
  frame[20] ^= 0xff;

  const bodyData = frame.subarray(4);
  assert.throws(() => {
    decryptLocoV2Frame(bodyData, aesKey);
  }, /Unsupported state or unable to authenticate data/);
});
