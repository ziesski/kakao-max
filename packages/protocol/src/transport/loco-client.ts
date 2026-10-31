import net from 'node:net';
import tls from 'node:tls';
import { BSON } from 'bson';
import { encodeLocoPacket, decodeLocoPacket, LOCO_HEADER_SIZE, LocoPacket } from '../framing/loco-packet.js';
import { createLocoV2Handshake, encryptLocoV2Frame, decryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { LocoError } from '../errors/loco-error.js';

/**
 * Decrypt every COMPLETE LocoV2SL frame at the front of `incoming` and return their
 * concatenated plaintext plus how many ciphertext bytes were consumed. A large LOCO
 * response (e.g. LOGINLIST) is split by the server across multiple GCM frames, each
 * `[4-byte len][12-byte IV][ciphertext][16-byte tag]`; their plaintexts concatenate to
 * form the LOCO packet byte-stream. A partial trailing frame is left for the next read.
 */
export function drainLocoFrames(incoming: Buffer, aesKey: Uint8Array): { plaintext: Buffer; consumed: number } {
  let consumed = 0;
  const parts: Buffer[] = [];
  while (incoming.length - consumed >= 4) {
    const frameLen = incoming.readUInt32LE(consumed);
    if (incoming.length - consumed < 4 + frameLen) break;
    const frame = incoming.subarray(consumed + 4, consumed + 4 + frameLen);
    parts.push(Buffer.from(decryptLocoV2Frame(frame, aesKey)));
    consumed += 4 + frameLen;
  }
  return { plaintext: parts.length ? Buffer.concat(parts) : Buffer.alloc(0), consumed };
}

/** Read the LOCO packet bodyLength (LE uint32 at header offset 18), or null if the header isn't complete yet. */
export function locoBodyLength(plain: Buffer): number | null {
  return plain.length < LOCO_HEADER_SIZE ? null : plain.readUInt32LE(18);
}

export interface BookingTrailerConfig {
  tokenExpireTime: number;
  concurrentUpLimit: number;
}

export interface BookingResult {
  status: number;
  ticketHosts: string[];
  ports: number[];
  revision: number;
  raw: Record<string, unknown>;
}

export interface CheckinResult {
  status: number;
  chatHost?: string;
  chatPort?: number;
  raw: Record<string, unknown>;
}

export interface ConversationItem {
  id: string;
  type: string;
  unreadCount?: number;
  lastMessage?: string;
  lastSendAt?: number;
  lastMessageType?: number;
  memberCount?: number;
  raw: Record<string, unknown>;
}

export interface LoginListResult {
  status: number;
  revision: number;
  conversations: ConversationItem[];
  raw: Record<string, unknown>;
}

export class LocoClient {
  private appVersion: string;
  private os: string;

  constructor(appVersion = '26.4.0', os = 'mac') {
    this.appVersion = appVersion;
    this.os = os;
  }

  /**
   * 1. GETCONF from booking server over TLS
   */
  async getBookingConfig(host = 'booking-loco.kakao.com', port = 443): Promise<BookingResult> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, timeout: 10000 }, () => {
        const req = {
          MCCMNC: this.os === 'android' ? '99999' : '999',
          model: '',
          os: this.os
        };
        const packet = encodeLocoPacket(1, 0, 'GETCONF', req);
        socket.write(packet);
      });

      let received = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= LOCO_HEADER_SIZE) {
          const bodyLen = received.readUInt32LE(18);
          if (received.length >= LOCO_HEADER_SIZE + bodyLen) {
            try {
              const decoded = decodeLocoPacket(received.subarray(0, LOCO_HEADER_SIZE + bodyLen));
              socket.end();
              const data = decoded.data as Record<string, any>;
              const ticketHosts = Array.isArray(data.ticket?.lsl) ? data.ticket.lsl : ['ticket-loco.kakao.com'];
              const ports = Array.isArray(data.wifi?.ports) ? data.wifi.ports : [5242];
              resolve({
                status: decoded.header.status,
                ticketHosts,
                ports,
                revision: Number(data.revision || 0),
                raw: data
              });
            } catch (err) {
              socket.destroy();
              reject(err);
            }
          }
        }
      });

      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new LocoError('TIMEOUT', 'Booking connection timed out', { command: 'GETCONF' }));
      });
    });
  }

  /**
   * 2. CHECKIN to ticket server using LocoV2SL
   */
  async checkin(ticketHost: string, ticketPort: number, userId: string | number): Promise<CheckinResult> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: ticketHost, port: ticketPort, timeout: 10000 }, () => {
        const { handshakeBytes, aesKey } = createLocoV2Handshake();

        const req = {
          MCCMNC: this.os === 'android' ? '99999' : '999',
          appVer: this.appVersion,
          countryISO: 'KR',
          lang: 'ko',
          ntype: 0,
          useSub: true,
          os: this.os,
          userId: new BSON.Long(BigInt(userId))
        };
        const plainPacket = encodeLocoPacket(1, 0, 'CHECKIN', req);
        const encryptedFrame = encryptLocoV2Frame(plainPacket, aesKey);

        socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedFrame)]));

        let incoming = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          incoming = Buffer.concat([incoming, chunk]);
          if (incoming.length >= 4) {
            const frameLen = incoming.readUInt32LE(0);
            if (incoming.length >= 4 + frameLen) {
              try {
                const decrypted = decryptLocoV2Frame(incoming.subarray(4, 4 + frameLen), aesKey);
                const decoded = decodeLocoPacket(decrypted);
                socket.end();
                const res = decoded.data as Record<string, any>;
                resolve({
                  status: Number(res.status ?? decoded.header.status),
                  chatHost: res.host,
                  chatPort: res.port ? Number(res.port) : undefined,
                  raw: res
                });
              } catch (err) {
                socket.destroy();
                reject(err);
              }
            }
          }
        });
      });

      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new LocoError('TIMEOUT', 'Ticket checkin timed out', { command: 'CHECKIN' }));
      });
    });
  }

  /**
   * 3. Connect to chat carriage server and perform LOGINLIST
   */
  async loginList(
    chatHost: string,
    chatPort: number,
    userId: string | number,
    accessToken: string,
    deviceUUID: string
  ): Promise<LoginListResult> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: chatHost, port: chatPort, timeout: 10000 }, () => {
        const { handshakeBytes, aesKey } = createLocoV2Handshake();

        const req = {
          appVer: this.appVersion,
          prtVer: '1',
          os: this.os,
          lang: 'ko',
          duuid: deviceUUID,
          oauthToken: accessToken,
          ...(this.os === 'android' ? { rp: new BSON.Binary(Buffer.from([0, 0, 255, 255, 0, 0])) } : {}),
          dtype: 2, // sub-device
          ntype: 0, // wifi
          MCCMNC: this.os === 'android' ? '99999' : '999',
          revision: 0,
          chatIds: [],
          maxIds: [],
          lastTokenId: BSON.Long.ZERO,
          lbk: 0,
          bg: false
        };
        const plainPacket = encodeLocoPacket(1, 0, 'LOGINLIST', req);
        const encryptedFrame = encryptLocoV2Frame(plainPacket, aesKey);

        socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedFrame)]));

        let incoming = Buffer.alloc(0);
        let plainBuf = Buffer.alloc(0);
        let done = false;
        socket.on('data', (chunk) => {
          if (done) return;
          incoming = Buffer.concat([incoming, chunk]);
          const { plaintext, consumed } = drainLocoFrames(incoming, aesKey);
          if (consumed > 0) {
            incoming = incoming.subarray(consumed);
            plainBuf = Buffer.concat([plainBuf, plaintext]);
          }
          const bodyLen = locoBodyLength(plainBuf);
          if (bodyLen !== null && plainBuf.length >= LOCO_HEADER_SIZE + bodyLen) {
              done = true;
              try {
                const decoded = decodeLocoPacket(plainBuf.subarray(0, LOCO_HEADER_SIZE + bodyLen));
                socket.end();
                const res = decoded.data as Record<string, any>;

                const conversations: ConversationItem[] = [];
                if (Array.isArray(res.chatDatas)) {
                  for (const c of res.chatDatas) {
                    const last = c.l;
                    const lastMsg = typeof last?.message === 'string' ? last.message : typeof last?.msg === 'string' ? last.msg : undefined;
                    const lastSendAt = typeof last?.sendAt === 'number' ? last.sendAt : typeof last?.s === 'number' ? last.s : undefined;
                    conversations.push({
                      id: String(c.c || c.channelId || ''),
                      type: String(c.t || c.type || ''),
                      unreadCount: typeof c.n === 'number' ? c.n : typeof c.u === 'number' ? c.u : undefined,
                      lastMessage: lastMsg,
                      lastSendAt,
                      lastMessageType: typeof last?.type === 'number' ? last.type : undefined,
                      memberCount: typeof c.a === 'number' ? c.a : undefined,
                      raw: c
                    });
                  }
                }

                resolve({
                  status: Number(res.status ?? decoded.header.status),
                  revision: Number(res.revision || 0),
                  conversations,
                  raw: res
                });
              } catch (err) {
                socket.destroy();
                reject(err);
              }
          }
        });
      });

      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new LocoError('TIMEOUT', 'Carriage loginList timed out', { command: 'LOGINLIST' }));
      });
    });
  }
}
