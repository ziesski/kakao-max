import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { BSON } from 'bson';
import { uploadMediaToTrailer, downloadMediaFromTrailer } from './trailer-client.js';
import { decryptLocoV2Frame, encryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { decodeLocoPacket, encodeLocoPacket } from '../framing/loco-packet.js';

test('uploadMediaToTrailer: handshakes, sends POST, streams chunks, and handles COMPLETE', async () => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  const testData = crypto.randomBytes(9000); // More than 2 chunks (4096 * 2 + 808)
  const receivedChunks: Buffer[] = [];

  const server = net.createServer((socket) => {
    let handshakeReceived = false;
    let aesKey: Uint8Array | null = null;
    let incoming = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);

      if (!handshakeReceived) {
        if (incoming.length < 268) return;
        const keyLen = incoming.readUInt32LE(0);
        const encryptedKey = incoming.subarray(12, 12 + keyLen);
        const decryptedKey = crypto.privateDecrypt(
          {
            key: privateKey.privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha1'
          },
          encryptedKey
        );
        aesKey = new Uint8Array(decryptedKey);
        handshakeReceived = true;
        incoming = incoming.subarray(12 + keyLen);
      }

      while (incoming.length >= 4) {
        const frameLen = incoming.readUInt32LE(0);
        if (incoming.length < 4 + frameLen) break;

        const framePayload = incoming.subarray(4, 4 + frameLen);
        incoming = incoming.subarray(4 + frameLen);

        if (!aesKey) throw new Error('aesKey not set');
        const decrypted = decryptLocoV2Frame(framePayload, aesKey);

        if (receivedChunks.length === 0 && decrypted.length > 20 && Buffer.from(decrypted).toString('ascii', 6, 10) === 'POST') {
          const decoded = decodeLocoPacket(decrypted);
          assert.equal(decoded.data.k, 'test_token');
          assert.equal(Number(decoded.data.s), testData.length);
          assert.equal(decoded.data.f, 'photo.jpg');

          // Send POST ack with offset 0
          const postAck = encodeLocoPacket(decoded.header.id, 0, 'POST', { status: 0, o: 0 });
          const encryptedAck = encryptLocoV2Frame(postAck, aesKey);
          socket.write(Buffer.from(encryptedAck));
        } else {
          receivedChunks.push(Buffer.from(decrypted));
          const totalReceived = receivedChunks.reduce((acc, c) => acc + c.length, 0);

          if (totalReceived >= testData.length) {
            // All bytes received! Send COMPLETE packet
            const completePkt = encodeLocoPacket(2, 0, 'COMPLETE', {
              status: 0,
              chatLog: {
                logId: new BSON.Long(999888777n),
                chatId: new BSON.Long(12345n),
                type: 2,
                authorId: new BSON.Long(42n),
                message: '사진',
                sendAt: 1234567890,
                attachment: '{"url":"https://test.cdn.net/pic.jpg"}'
              }
            });
            const encryptedComplete = encryptLocoV2Frame(completePkt, aesKey);
            socket.write(Buffer.from(encryptedComplete));
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const result = await uploadMediaToTrailer({
      host: '127.0.0.1',
      port,
      token: 'test_token',
      userId: 42,
      chatId: 12345,
      data: testData,
      type: 2,
      fileName: 'photo.jpg',
      rsaPublicKeyPem: privateKey.publicKey
    });

    assert.equal(result.status, 0);
    assert.equal(result.chatLog.logId, '999888777');
    assert.equal(result.chatLog.chatId, '12345');
    assert.equal(result.chatLog.authorId, '42');
    assert.equal(result.chatLog.message, '사진');

    const reconstructed = Buffer.concat(receivedChunks);
    assert.deepEqual(reconstructed, testData);
  } finally {
    server.close();
  }
});

test('downloadMediaFromTrailer: handshakes, sends DOWN, receives ack and decrypts streamed chunks', async () => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  const testPayload = crypto.randomBytes(12500); // multiple chunks
  let downRequestReceived = false;

  const server = net.createServer((socket) => {
    socket.on('error', () => { /* Size-limit rejection intentionally closes the fixture peer. */ });
    let handshakeReceived = false;
    let aesKey: Uint8Array | null = null;
    let incoming = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);

      if (!handshakeReceived) {
        if (incoming.length < 268) return;
        const keyLen = incoming.readUInt32LE(0);
        const encryptedKey = incoming.subarray(12, 12 + keyLen);
        const decryptedKey = crypto.privateDecrypt(
          {
            key: privateKey.privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha1'
          },
          encryptedKey
        );
        aesKey = new Uint8Array(decryptedKey);
        handshakeReceived = true;
        incoming = incoming.subarray(12 + keyLen);
      }

      while (incoming.length >= 4) {
        const frameLen = incoming.readUInt32LE(0);
        if (incoming.length < 4 + frameLen) break;

        const framePayload = incoming.subarray(4, 4 + frameLen);
        incoming = incoming.subarray(4 + frameLen);

        if (!aesKey) throw new Error('aesKey not set');
        const decrypted = decryptLocoV2Frame(framePayload, aesKey);

        const decoded = decodeLocoPacket(decrypted);
        if (decoded.header.method.trim() === 'DOWN') {
          downRequestReceived = true;
          assert.equal(decoded.data.k, 'download_token_123');
          assert.equal(decoded.data.rt, true);

          // 1. Send DOWN response with expected size
          const downAck = encodeLocoPacket(decoded.header.id, 0, 'DOWN', { status: 0, s: testPayload.length });
          const encryptedAck = encryptLocoV2Frame(downAck, aesKey);
          socket.write(Buffer.from(encryptedAck));

          // 2. Stream the data in 4KB chunks
          const CHUNK_SIZE = 4096;
          let curr = 0;
          while (curr < testPayload.length) {
            const next = Math.min(curr + CHUNK_SIZE, testPayload.length);
            const slice = testPayload.subarray(curr, next);
            const encryptedChunk = encryptLocoV2Frame(slice, aesKey);
            socket.write(Buffer.from(encryptedChunk));
            curr = next;
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const result = await downloadMediaFromTrailer({
      host: '127.0.0.1',
      port,
      token: 'download_token_123',
      userId: 42,
      chatId: 12345,
      rsaPublicKeyPem: privateKey.publicKey, maxBytes: testPayload.length
    });

    assert.equal(downRequestReceived, true);
    assert.equal(result.status, 0);
    assert.equal(result.size, testPayload.length);
    assert.deepEqual(Buffer.from(result.data), testPayload);
    await assert.rejects(downloadMediaFromTrailer({ host: '127.0.0.1', port, token: 'download_token_123', userId: 42, chatId: 12345, rsaPublicKeyPem: privateKey.publicKey, maxBytes: 32 }), /download limit/);
  } finally {
    server.close();
  }
});

test('downloadMediaFromTrailer streams chunks directly into sink without buffering', async () => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  const testPayload = crypto.randomBytes(9000);
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let handshakeReceived = false;
    let aesKey: Uint8Array | null = null;
    let incoming = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);

      if (!handshakeReceived) {
        if (incoming.length < 268) return;
        const keyLen = incoming.readUInt32LE(0);
        const encryptedKey = incoming.subarray(12, 12 + keyLen);
        const decryptedKey = crypto.privateDecrypt(
          { key: privateKey.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
          encryptedKey
        );
        aesKey = new Uint8Array(decryptedKey);
        handshakeReceived = true;
        incoming = incoming.subarray(12 + keyLen);
      }

      while (incoming.length >= 4) {
        const frameLen = incoming.readUInt32LE(0);
        if (incoming.length < 4 + frameLen) break;
        const framePayload = incoming.subarray(4, 4 + frameLen);
        incoming = incoming.subarray(4 + frameLen);

        if (!aesKey) throw new Error('aesKey not set');
        const decrypted = decryptLocoV2Frame(framePayload, aesKey);
        const decoded = decodeLocoPacket(decrypted);

        if (decoded.header.method.trim() === 'DOWN') {
          const downAck = encodeLocoPacket(decoded.header.id, 0, 'DOWN', { status: 0, s: testPayload.length });
          socket.write(Buffer.from(encryptLocoV2Frame(downAck, aesKey)));

          const CHUNK_SIZE = 4096;
          let curr = 0;
          while (curr < testPayload.length) {
            const next = Math.min(curr + CHUNK_SIZE, testPayload.length);
            const slice = testPayload.subarray(curr, next);
            socket.write(Buffer.from(encryptLocoV2Frame(slice, aesKey)));
            curr = next;
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const sinkChunks: Buffer[] = [];
    const result = await downloadMediaFromTrailer({
      host: '127.0.0.1',
      port,
      token: 'sink_token_123',
      userId: 42,
      chatId: 12345,
      rsaPublicKeyPem: privateKey.publicKey,
      sink: async (chunk, offset, total) => {
        assert.equal(total, testPayload.length);
        sinkChunks.push(Buffer.from(chunk));
      }
    });

    assert.equal(result.status, 0);
    assert.equal(result.size, testPayload.length);
    assert.equal(result.data.length, 0); // zero buffered bytes in memory
    assert.deepEqual(Buffer.concat(sinkChunks), testPayload);
  } finally {
    server.close();
  }
});

/** Trailer fixture that answers DOWN with `payload`, writing each encrypted frame in `pieces` parts `gapMs` apart. */
async function trailerFixture(payload: Buffer, o: { pieces?: number; gapMs?: number; stopAfterFrames?: number } = {}) {
  const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let aesKey: Uint8Array | null = null;
    let incoming = Buffer.alloc(0);
    socket.on('data', async chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      if (!aesKey) {
        if (incoming.length < 268) return;
        const keyLen = incoming.readUInt32LE(0);
        aesKey = new Uint8Array(crypto.privateDecrypt(
          { key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
          incoming.subarray(12, 12 + keyLen)));
        incoming = incoming.subarray(12 + keyLen);
      }
      if (incoming.length < 4 || incoming.length < 4 + incoming.readUInt32LE(0)) return;
      const key = aesKey;
      const frames = [Buffer.from(encryptLocoV2Frame(encodeLocoPacket(1, 0, 'DOWN', { status: 0, s: payload.length }), key))];
      for (let at = 0; at < payload.length; at += 4096) frames.push(Buffer.from(encryptLocoV2Frame(payload.subarray(at, at + 4096), key)));
      const pieces = o.pieces ?? 1;
      for (const [n, frame] of frames.entries()) {
        if (o.stopAfterFrames !== undefined && n >= o.stopAfterFrames) return; // stall without closing
        const step = Math.ceil(frame.length / pieces);
        for (let at = 0; at < frame.length; at += step) {
          if (socket.destroyed) return;
          socket.write(frame.subarray(at, at + step));
          if (o.gapMs) await sleep(o.gapMs);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return { server, base: { host: '127.0.0.1', port, token: 'fixture_token', userId: 42, chatId: 12345, rsaPublicKeyPem: keys.publicKey } };
}

test('a frame split across TCP reads is reassembled without re-entering the frame loop', async () => {
  const payload = crypto.randomBytes(9000);
  const { server, base } = await trailerFixture(payload, { pieces: 3, gapMs: 5 });
  try {
    const buffered = await downloadMediaFromTrailer({ ...base, maxBytes: 16 * 1024 * 1024 });
    assert.deepEqual(Buffer.from(buffered.data), payload);
    const streamed: Buffer[] = [];
    const res = await downloadMediaFromTrailer({ ...base, sink: async c => { await new Promise(r => setTimeout(r, 2)); streamed.push(Buffer.from(c)); } });
    assert.equal(res.size, payload.length);
    assert.deepEqual(Buffer.concat(streamed), payload);
  } finally {
    server.close();
  }
});

test('idleTimeoutMs lets a slow but steady download outlive it, while timeoutMs stays a total deadline', async () => {
  const payload = crypto.randomBytes(5 * 4096);
  const { server, base } = await trailerFixture(payload, { pieces: 2, gapMs: 40 });
  try {
    // About 13 writes 40ms apart: well past 150ms in total, never 150ms without data.
    const res = await downloadMediaFromTrailer({ ...base, idleTimeoutMs: 150, sink: () => {} });
    assert.equal(res.size, payload.length);
    await assert.rejects(downloadMediaFromTrailer({ ...base, timeoutMs: 150, sink: () => {} }), (e: any) => e.code === 'TIMEOUT');
  } finally {
    server.close();
  }
});

test('idleTimeoutMs fails a download that stalls mid-stream', async () => {
  const payload = crypto.randomBytes(3 * 4096);
  const { server, base } = await trailerFixture(payload, { stopAfterFrames: 2 });
  try {
    const started = Date.now();
    await assert.rejects(downloadMediaFromTrailer({ ...base, idleTimeoutMs: 100, sink: () => {} }), (e: any) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.close();
  }
});

test('a sink that throws fails the download instead of reporting success', async () => {
  const payload = crypto.randomBytes(9000);
  const { server, base } = await trailerFixture(payload);
  try {
    await assert.rejects(downloadMediaFromTrailer({ ...base, sink: () => { throw new Error('disk full'); } }), /disk full/);
  } finally {
    server.close();
  }
});


test('reused media POST commits with full resume offset, sends no file bytes and waits for COMPLETE', async () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'pkcs1', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const payload = Buffer.from('fixture-reused-file'); let posts = 0, bytesSent = 0;
  const server = net.createServer(socket => {
    let incoming = Buffer.alloc(0), aes: Uint8Array | undefined;
    socket.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      if (!aes) {
        if (incoming.length < 268) return;
        const length = incoming.readUInt32LE(0);
        aes = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, incoming.subarray(12, 12 + length));
        incoming = incoming.subarray(12 + length);
      }
      while (incoming.length >= 4 && incoming.length >= 4 + incoming.readUInt32LE(0)) {
        const length = incoming.readUInt32LE(0), frame = incoming.subarray(4, 4 + length); incoming = incoming.subarray(4 + length);
        const decoded = decryptLocoV2Frame(frame, aes);
        if (!posts) {
          const packet = decodeLocoPacket(decoded); assert.equal(packet.header.method.trim(), 'POST'); assert.equal(packet.data.f, 'fixture.txt'); posts++;
          socket.write(Buffer.from(encryptLocoV2Frame(encodeLocoPacket(1, 0, 'POST', { status: 0, o: payload.length }), aes)));
          setTimeout(() => socket.write(Buffer.from(encryptLocoV2Frame(encodeLocoPacket(2, 0, 'COMPLETE', { status: 0, chatLog: { logId: BSON.Long.fromString('123456790'), chatId: BSON.Long.fromString('987654321'), type: 18, message: 'fixture.txt' } }), aes!))), 20);
        } else bytesSent += decoded.length;
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await uploadMediaToTrailer({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, token: 'fixture-reuse-token', userId: '123456789', chatId: '987654321', data: payload, type: 18, fileName: 'fixture.txt', rsaPublicKeyPem: keys.publicKey, timeoutMs: 2000 });
    assert.equal(result.chatLog.logId, '123456790'); assert.equal(posts, 1); assert.equal(bytesSent, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
