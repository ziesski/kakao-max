import net from 'node:net';
import { BSON } from 'bson';
import { createLocoV2Handshake, encryptLocoV2Frame, decryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { encodeLocoPacket, decodeLocoPacket } from '../framing/loco-packet.js';
import { LocoError } from '../errors/loco-error.js';

export interface TrailerUploadOptions {
  host: string;
  port: number;
  token: string;
  userId: string | number;
  chatId: string | number;
  data: Uint8Array;
  type: number; // 2=Photo, 3=Video, 5=Audio, 18=File, etc.
  fileName?: string;
  width?: number;
  height?: number;
  extra?: string;
  appVersion?: string;
  os?: string;
  rsaPublicKeyPem?: string;
  timeoutMs?: number;
}

export interface TrailerUploadResult {
  status: number;
  chatLog: {
    logId: string;
    chatId: string;
    type: number;
    authorId: string;
    message: string;
    sendAt: number;
    attachment?: string;
    [key: string]: any;
  };
  raw: Record<string, any>;
}

export interface TrailerDownloadOptions {
  maxBytes?: number;
  host: string;
  port: number;
  token: string;
  userId: string | number;
  chatId: string | number;
  offset?: number;
  isMini?: boolean;
  width?: number;
  height?: number;
  appVersion?: string;
  os?: string;
  rsaPublicKeyPem?: string;
  /** Total deadline from connect. Defaults to 30s unless only `idleTimeoutMs` is given. */
  timeoutMs?: number;
  /** Fail when no bytes arrive for this long; long transfers that keep moving are allowed. */
  idleTimeoutMs?: number;
  sink?: TrailerChunkSink;
}

export type TrailerChunkSink = (chunk: Uint8Array, offset: number, totalExpected: number) => void | Promise<void>;

export interface TrailerDownloadResult {
  status: number;
  data: Uint8Array;
  size: number;
}

/**
 * Downloads media bytes from KakaoTalk's Trailer Server (vh:995) via LocoV2SL:
 * 1. Connects to `host:port` (995) over TCP.
 * 2. Handshakes with LocoV2SL (RSA-OAEP 16-byte AES-128-GCM key).
 * 3. Sends LOCO `DOWN` (or `MINI`) request with token and metadata.
 * 4. Receives `DOWN` ack with expected data size (`s`).
 * 5. Streams encrypted LocoV2SL chunks and decrypts them until `size` bytes are accumulated.
 */
export async function downloadMediaFromTrailer(opts: TrailerDownloadOptions): Promise<TrailerDownloadResult> {
  // An idle-only download (large media streamed to a sink) has no total deadline.
  const timeoutMs = opts.timeoutMs ?? (opts.idleTimeoutMs === undefined ? 30000 : undefined);
  const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));

  return new Promise((resolve, reject) => {
    let deadline: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (err: unknown, result?: TrailerDownloadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(idle);
      if (err) { socket.destroy(); reject(err); } else { socket.end(); resolve(result!); }
    };
    const timedOut = (ms: number, kind: string) => () =>
      finish(new LocoError('TIMEOUT', `Trailer download ${kind} after ${ms}ms`, { command: 'DOWN' }));
    const touch = () => {
      if (opts.idleTimeoutMs === undefined || settled) return;
      clearTimeout(idle);
      idle = setTimeout(timedOut(opts.idleTimeoutMs, 'idle'), opts.idleTimeoutMs);
    };
    const socket = net.connect({ host: opts.host, port: opts.port }, () => {
      if (timeoutMs !== undefined) deadline = setTimeout(timedOut(timeoutMs, 'timed out'), timeoutMs);
      touch();

      const { handshakeBytes, aesKey } = createLocoV2Handshake(opts.rsaPublicKeyPem);

      let reqPacket: Uint8Array;
      if (opts.isMini) {
        const miniBody = {
          u: toLong(opts.userId),
          k: opts.token,
          o: toLong(opts.offset ?? 0),
          c: toLong(opts.chatId),
          mm: '999',
          nt: 0,
          os: opts.os ?? 'mac',
          av: opts.appVersion ?? '26.4.0',
          w: opts.width ?? 0,
          h: opts.height ?? 0
        };
        reqPacket = encodeLocoPacket(1, 0, 'MINI', miniBody);
      } else {
        const downBody = {
          u: toLong(opts.userId),
          k: opts.token,
          o: toLong(opts.offset ?? 0),
          c: toLong(opts.chatId),
          mm: '999',
          nt: 0,
          os: opts.os ?? 'mac',
          av: opts.appVersion ?? '26.4.0',
          rt: true
        };
        reqPacket = encodeLocoPacket(1, 0, 'DOWN', downBody);
      }

      const encryptedReq = encryptLocoV2Frame(reqPacket, aesKey);
      socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedReq)]));

      let incoming = Buffer.alloc(0);
      let headerAcked = false;
      let expectedSize = 0;
      let receivedBytes = 0;
      const chunks: Buffer[] = [];
      let draining = false;

      /** Handle one complete frame. Returns true once the download is settled. */
      const handleFrame = async (framePayload: Buffer): Promise<boolean> => {
        const decrypted = decryptLocoV2Frame(framePayload, aesKey);
        if (!headerAcked) {
          headerAcked = true;
          const decoded = decodeLocoPacket(decrypted);
          const method = decoded.header.method.trim();
          if (decoded.header.status !== 0) {
            throw new LocoError('STATUS', `Trailer ${method} rejected with status ${decoded.header.status}`, { command: method, status: decoded.header.status });
          }
          expectedSize = Number(decoded.data.s ?? decoded.data.size ?? 0);
          if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || (opts.maxBytes !== undefined && expectedSize > opts.maxBytes)) {
            throw new LocoError('MALFORMED', 'Trailer media exceeds download limit');
          }
          if (expectedSize === 0) { finish(undefined, { status: 0, data: new Uint8Array(0), size: 0 }); return true; }
          return false;
        }
        if (opts.maxBytes !== undefined && receivedBytes + decrypted.length > expectedSize) {
          throw new LocoError('MALFORMED', 'Trailer media exceeds announced size');
        }
        const chunkData = decrypted.subarray(0, Math.min(decrypted.length, expectedSize - receivedBytes));
        const chunkOffset = receivedBytes;
        receivedBytes += chunkData.length;
        if (opts.sink) await opts.sink(chunkData, chunkOffset, expectedSize);
        else chunks.push(Buffer.from(chunkData));
        if (receivedBytes < expectedSize) return false;
        finish(undefined, { status: 0, data: opts.sink ? new Uint8Array(0) : Buffer.concat(chunks), size: expectedSize });
        return true;
      };

      // One drain loop at a time. The socket is paused while a sink write is pending so a slow disk
      // cannot make `incoming` grow without bound; a partial frame simply waits for the next read.
      const drain = async () => {
        if (draining || settled) return;
        draining = true;
        try {
          while (!settled && incoming.length >= 4) {
            const frameLen = incoming.readUInt32LE(0);
            if (opts.maxBytes !== undefined && frameLen > opts.maxBytes + 65536) {
              throw new LocoError('MALFORMED', 'Trailer frame exceeds download limit');
            }
            if (incoming.length < 4 + frameLen) break;
            const framePayload = incoming.subarray(4, 4 + frameLen);
            incoming = incoming.subarray(4 + frameLen);
            socket.pause();
            try {
              if (await handleFrame(framePayload)) return;
            } finally {
              if (!settled) socket.resume();
            }
          }
        } catch (err) {
          finish(err);
        } finally {
          draining = false;
        }
      };

      socket.on('data', (chunk) => {
        touch();
        incoming = incoming.length === 0 ? Buffer.from(chunk) : Buffer.concat([incoming, chunk]);
        void drain();
      });
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new LocoError('CLOSED', 'Trailer download closed before completion')));
  });
}

/**
 * Uploads media bytes to KakaoTalk's Trailer Server (vh:995) via LocoV2SL:
 * 1. Connects to `host:port` (995) over TCP.
 * 2. Handshakes with LocoV2SL (RSA-OAEP 16-byte AES-128-GCM key).
 * 3. Sends LOCO `POST` request with media metadata and the `k` upload token from `SHIP`.
 * 4. Receives `POST` ack with byte offset (`o`).
 * 5. Streams encrypted 4KB chunks of media bytes.
 * 6. Receives LOCO `COMPLETE` with committed `chatLog`.
 */
export async function uploadMediaToTrailer(opts: TrailerUploadOptions): Promise<TrailerUploadResult> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const toLong = (v: string | number) => (typeof v === 'number' ? BSON.Long.fromNumber(v) : BSON.Long.fromString(String(v)));

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const socket = net.connect({ host: opts.host, port: opts.port }, () => {
      timer = setTimeout(() => {
        socket.destroy();
        reject(new LocoError('TIMEOUT', `Trailer upload timed out after ${timeoutMs}ms`, { command: 'POST' }));
      }, timeoutMs);

      const { handshakeBytes, aesKey } = createLocoV2Handshake(opts.rsaPublicKeyPem);

      const postBody = {
        u: toLong(opts.userId),
        k: opts.token,
        t: opts.type,
        s: BSON.Long.fromNumber(opts.data.length),
        c: toLong(opts.chatId),
        mid: toLong(Math.floor(Math.random() * 0x7fffffff)),
        w: opts.width ?? 0,
        h: opts.height ?? 0,
        mm: '999',
        nt: 0,
        os: opts.os ?? 'mac',
        av: opts.appVersion ?? '26.4.0',
        ex: opts.extra ?? '{}',
        f: opts.fileName ?? '',
        sp: '',
        scp: 1,
        silence: false,
        ns: false
      };

      const postPacket = encodeLocoPacket(1, 0, 'POST', postBody);
      const encryptedPost = encryptLocoV2Frame(postPacket, aesKey);

      socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedPost)]));

      let incoming = Buffer.alloc(0);
      let postAcked = false;

      socket.on('data', (chunk) => {
        incoming = Buffer.concat([incoming, chunk]);

        while (incoming.length >= 4) {
          const frameLen = incoming.readUInt32LE(0);
          if (incoming.length < 4 + frameLen) break;

          const framePayload = incoming.subarray(4, 4 + frameLen);
          incoming = incoming.subarray(4 + frameLen);

          try {
            const decrypted = decryptLocoV2Frame(framePayload, aesKey);
            const decoded = decodeLocoPacket(decrypted);
            const method = decoded.header.method.trim();

            if (method === 'POST' && !postAcked) {
              postAcked = true;
              if (decoded.header.status !== 0) {
                socket.destroy();
                clearTimeout(timer);
                return reject(new LocoError('STATUS', `Trailer POST rejected with status ${decoded.header.status}`, { command: 'POST', status: decoded.header.status }));
              }

              const offset = Number(decoded.data.o ?? decoded.data.offset ?? 0);
              const CHUNK_SIZE = 4096;
              let curr = offset;
              while (curr < opts.data.length) {
                const next = Math.min(curr + CHUNK_SIZE, opts.data.length);
                const slice = opts.data.subarray(curr, next);
                const encryptedChunk = encryptLocoV2Frame(slice, aesKey);
                socket.write(Buffer.from(encryptedChunk));
                curr = next;
              }
            } else if (method === 'COMPLETE') {
              clearTimeout(timer);
              socket.end();

              if (decoded.header.status !== 0) {
                return reject(new LocoError('STATUS', `Trailer COMPLETE returned status ${decoded.header.status}`, { command: 'COMPLETE', status: decoded.header.status }));
              }

              const chatLog = (decoded.data.chatLog || {}) as Record<string, any>;
              return resolve({
                status: Number(decoded.data.status ?? decoded.header.status ?? 0),
                chatLog: {
                  ...chatLog,
                  logId: chatLog.logId?.toString() ?? '',
                  chatId: chatLog.chatId?.toString() ?? String(opts.chatId),
                  authorId: chatLog.authorId?.toString() ?? String(opts.userId),
                  type: Number(chatLog.type ?? opts.type),
                  message: String(chatLog.message ?? ''),
                  sendAt: Number(chatLog.sendAt ?? Math.floor(Date.now() / 1000))
                },
                raw: decoded.data
              });
            }
          } catch (err) {
            clearTimeout(timer);
            socket.destroy();
            return reject(err);
          }
        }
      });
    });

    socket.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    socket.on('close', () => {
      if (timer) clearTimeout(timer);
    });
  });
}
