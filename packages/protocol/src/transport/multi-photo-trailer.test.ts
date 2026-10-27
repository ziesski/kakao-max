import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { uploadPhotoItemToTrailer } from './multi-photo-trailer.js';
import { decryptLocoV2Frame, encryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { decodeLocoPacket, encodeLocoPacket } from '../framing/loco-packet.js';

test('encrypted MPOST uploads only the resumed item bytes and requires COMPLETE without a chatLog', async () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const data = crypto.randomBytes(9000);
  for (const scenario of ['success', 'bad-offset', 'early-complete', 'close', 'reject']) {
    let requestCount = 0; const received: Buffer[] = [];
    const server = net.createServer(socket => {
      let incoming = Buffer.alloc(0), key: Uint8Array | undefined, requested = false;
      socket.on('error', () => { /* A rejected upload closes its test peer. */ });
      socket.on('data', chunk => {
        incoming = Buffer.concat([incoming, chunk]);
        if (!key) {
          if (incoming.length < 268) return;
          key = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, incoming.subarray(12, 268));
          incoming = incoming.subarray(268);
        }
        while (incoming.length >= 4) {
          const n = incoming.readUInt32LE(0); if (incoming.length < n + 4) return;
          const bytes = decryptLocoV2Frame(incoming.subarray(4, n + 4), key);
          incoming = incoming.subarray(n + 4);
          if (!requested) {
            requested = true; requestCount++;
            const packet = decodeLocoPacket(bytes);
            assert.equal(packet.header.method.trim(), 'MPOST');
            assert.equal(packet.data.k, 'synthetic-item'); assert.equal(packet.data.t, 27); assert.equal(packet.data.dt, 2);
            assert.equal(String(packet.data.s), '9000'); assert.equal(String(packet.data.u), '9007199254740993');
            assert.equal('ex' in packet.data, false); assert.equal('c' in packet.data, false);
            if (scenario === 'close') { socket.end(); return; }
            const response = scenario === 'early-complete' ? 'COMPLETE' : 'MPOST';
            const ack = encodeLocoPacket(1, scenario === 'reject' ? -500 : 0, response, { o: scenario === 'bad-offset' ? 9001 : 4096 });
            const wire = Buffer.from(encryptLocoV2Frame(ack, key));
            socket.write(wire.subarray(0, 3)); socket.write(wire.subarray(3));
          } else {
            received.push(Buffer.from(bytes));
            if (Buffer.concat(received).length === data.length - 4096) {
              assert.deepEqual(Buffer.concat(received), data.subarray(4096));
              socket.write(Buffer.from(encryptLocoV2Frame(encodeLocoPacket(1, 0, 'COMPLETE', {}), key)));
            }
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const run = () => uploadPhotoItemToTrailer({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port,
      token: 'synthetic-item', userId: '9007199254740993', data, os: 'mac', appVersion: '26.4.0', rsaPublicKeyPem: keys.publicKey, timeoutMs: 2000 });
    try {
      if (scenario === 'success') await run(); else await assert.rejects(run());
      assert.equal(requestCount, 1);
      if (scenario !== 'success') assert.equal(received.length, 0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
