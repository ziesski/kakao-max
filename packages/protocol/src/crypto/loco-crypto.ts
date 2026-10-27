import crypto from 'node:crypto';
import { LocoError } from '../errors/loco-error.js';

export const MODERN_LOCO_RSA_PUBLIC_KEY = `-----BEGIN RSA PUBLIC KEY-----
MIIBCAKCAQEAo7B26MRFhR8ZpnDCMarG20Lv0JcX0GBIpcxWkGzRqye53zf/1QF+
fBOhQFtdHD5IeaakmdPGGKckcrC1DKXvHvbupwNp2UE/5mLY4rR5qfchQu5wzubC
rRIEXVKyXEogSiiWjjfwumpJ7j7J8qx6ZRhBYPIvYsQ6QGfNjSpvE9m4KYqwAnY9
I2ydGHnX/OW4+pEIgrIeFSR+DQokeRMI5RmDYUQC6foDBXxX6eF4scw5/mcojvxG
GUXLyqEdH8wSPnULhh8NRH6+PBFfQRpC3JXdsh2kJ3SlvLHd9/pfEGKAEMdPNvMc
QO/P4on9gbq6RKZVamwwEhBBS2Ajw/RjcQIBAw==
-----END RSA PUBLIC KEY-----`;

export interface LocoV2Handshake {
  handshakeBytes: Uint8Array;
  aesKey: Uint8Array;
}

/**
 * Creates the 268-byte LocoV2SL handshake packet:
 * - 4 bytes: length of encrypted key (uint32 LE, 256)
 * - 4 bytes: public key cipher type (0x10 = RSA OAEP SHA-1)
 * - 4 bytes: stream cipher type (0x03 = AES-128-GCM)
 * - 256 bytes: RSA-OAEP encrypted 16-byte random AES key
 */
export function createLocoV2Handshake(
  rsaPublicKeyPem: string = MODERN_LOCO_RSA_PUBLIC_KEY
): LocoV2Handshake {
  const aesKey = crypto.randomBytes(16);

  const encryptedKey = crypto.publicEncrypt(
    {
      key: rsaPublicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1'
    },
    aesKey
  );

  const header = Buffer.alloc(12);
  header.writeUInt32LE(encryptedKey.length, 0);
  header.writeUInt32LE(0x10, 4);
  header.writeUInt32LE(0x03, 8);

  const handshakeBytes = Buffer.concat([header, encryptedKey]);
  return { handshakeBytes: new Uint8Array(handshakeBytes), aesKey: new Uint8Array(aesKey) };
}

/**
 * Encrypts a plaintext LOCO packet using LocoV2SL (AES-128-GCM):
 * Output frame structure on the wire:
 * - 4 bytes: total payload length (uint32 LE: 12 + ciphertext.length + 16)
 * - 12 bytes: IV (random nonce)
 * - N bytes: AES-128-GCM ciphertext
 * - 16 bytes: GCM authentication tag
 */
export function encryptLocoV2Frame(plainPacket: Uint8Array, aesKey: Uint8Array): Uint8Array {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainPacket), cipher.final()]);
  const tag = cipher.getAuthTag();

  const bodyData = Buffer.concat([iv, encrypted, tag]);
  const frameHeader = Buffer.alloc(4);
  frameHeader.writeUInt32LE(bodyData.length, 0);

  return new Uint8Array(Buffer.concat([frameHeader, bodyData]));
}

/**
 * Decrypts a LocoV2SL frame payload (excluding the 4-byte frame length header):
 * - 12 bytes: IV
 * - N bytes: Ciphertext
 * - 16 bytes: GCM authentication tag
 */
export function decryptLocoV2Frame(bodyData: Uint8Array, aesKey: Uint8Array): Uint8Array {
  if (bodyData.length < 28) {
    throw new LocoError('MALFORMED', `LocoV2 body too short: expected at least 28 bytes (12 IV + 16 Tag), got ${bodyData.length}`);
  }
  const iv = bodyData.subarray(0, 12);
  const tag = bodyData.subarray(bodyData.length - 16);
  const ciphertext = bodyData.subarray(12, bodyData.length - 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return new Uint8Array(decrypted);
}
