import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLocoPacket, decodeLocoHeader, decodeLocoPacket, LOCO_HEADER_SIZE } from './loco-packet.js';

test('LOCO Packet Encoding and Decoding Roundtrip', () => {
  const payload = {
    MCCMNC: '999',
    model: '',
    os: 'win32',
    count: 42
  };

  const encoded = encodeLocoPacket(101, 0, 'GETCONF', payload);
  assert.equal(encoded.length >= LOCO_HEADER_SIZE, true);

  const header = decodeLocoHeader(encoded.subarray(0, LOCO_HEADER_SIZE));
  assert.equal(header.id, 101);
  assert.equal(header.status, 0);
  assert.equal(header.method, 'GETCONF');
  assert.equal(header.dataType, 0);

  const decoded = decodeLocoPacket<typeof payload>(encoded);
  assert.equal(decoded.header.id, 101);
  assert.equal(decoded.header.method, 'GETCONF');
  assert.equal(decoded.data.MCCMNC, '999');
  assert.equal(decoded.data.os, 'win32');
  assert.equal(decoded.data.count, 42);
});

test('LOCO Method length validation', () => {
  assert.throws(() => {
    encodeLocoPacket(1, 0, 'TOOLONGMETHODNAME', {});
  }, /exceeds 11 bytes/);
});
