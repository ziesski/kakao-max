import net from 'node:net';
import { BSON } from 'bson';
import { createLocoV2Handshake, encryptLocoV2Frame, decryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { encodeLocoPacket, decodeLocoPacket } from '../framing/loco-packet.js';
import { LocoError } from '../errors/loco-error.js';

/** Upload-only MPOST on the allocated trailer. Does not publish a chat message. */
export function uploadPhotoItemToTrailer(opts: {
  host: string; port: number; token: string; userId: string; data: Uint8Array;
  appVersion: string; os: string; timeoutMs?: number; rsaPublicKeyPem?: string;
}): Promise<void> {
  const timeout = opts.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000 || !opts.data.length || opts.data.length > 16 * 1024 * 1024) {
    return Promise.reject(new LocoError('INVALID_ARGUMENT', 'Invalid photo item upload size or timeout'));
  }
  const { handshakeBytes, aesKey } = createLocoV2Handshake(opts.rsaPublicKeyPem);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false, acked = false, incoming = Buffer.alloc(0);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new LocoError('TIMEOUT', 'Photo item upload timed out', { command: 'MPOST' })), timeout);
    socket.once('connect', () => {
      // MPOST body: per-item k/s, type27, deviceType2, no chatId/extra/master token.
      const body = { u: BSON.Long.fromString(opts.userId), k: opts.token, t: 27, s: BSON.Long.fromNumber(opts.data.length),
        scp: 1, tid: BSON.Long.ZERO, mm: '999', nt: 0, os: opts.os, av: opts.appVersion, dt: 2 };
      socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptLocoV2Frame(encodeLocoPacket(1, 0, 'MPOST', body), aesKey))]));
    });
    socket.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      try {
        while (incoming.length >= 4) {
          const length = incoming.readUInt32LE(0);
          if (length < 1 || length > 1024 * 1024) throw new LocoError('MALFORMED', 'Invalid photo upload response frame');
          if (incoming.length < 4 + length) return;
          const frame = incoming.subarray(4, 4 + length); incoming = incoming.subarray(4 + length);
          const packet = decodeLocoPacket(decryptLocoV2Frame(frame, aesKey));
          const status = Number(packet.header.status) || Number(packet.data.status ?? 0);
          if (status !== 0) throw new LocoError('STATUS', 'Photo item upload rejected', { command: packet.header.method, status });
          const method = packet.header.method.trim();
          if (method === 'MPOST' && !acked) {
            const offset = Number(packet.data.o);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > opts.data.length) {
              throw new LocoError('MALFORMED', 'Photo upload offset is outside the selected item');
            }
            acked = true;
            for (let i = offset; i < opts.data.length; i += 4096) {
              socket.write(Buffer.from(encryptLocoV2Frame(opts.data.subarray(i, i + 4096), aesKey)));
            }
          } else if (method === 'COMPLETE' && acked) { finish(); return; }
          else throw new LocoError('MALFORMED', 'Unexpected photo upload response order', { command: method });
        }
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid photo upload response')); }
    });
    socket.once('error', () => finish(new LocoError('UNREACHABLE', 'Photo upload connection failed', { command: 'MPOST' })));
    socket.once('close', () => { if (!settled) finish(new LocoError('CLOSED', 'Photo upload closed before COMPLETE', { command: 'MPOST' })); });
    socket.connect(opts.port, opts.host);
  });
}
