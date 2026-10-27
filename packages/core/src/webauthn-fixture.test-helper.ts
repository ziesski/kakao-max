// Test-only software authenticator. It emulates what a browser hands the page, so the daemon's
// verification can be exercised without a real device; it is never imported by runtime code.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
export interface FixtureAuthenticator {
  credentialId: string; publicKey: string; alg: -7 | -8;
  register(challenge: Buffer, origin: string, opts?: { flags?: number }): { credentialId: string; publicKey: string; alg: number; clientDataJSON: string; authenticatorData: string };
  assert(challenge: Buffer, origin: string, opts?: { flags?: number; counter?: number; type?: string; rpId?: string }): { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string };
}
export function fixtureAuthenticator(alg: -7 | -8 = -7): FixtureAuthenticator {
  const keys = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('ed25519');
  const id = randomBytes(16), privateKey: KeyObject = keys.privateKey;
  let counter = 0;
  const auth = (rpId: string, flags: number, count: number, attested: boolean) => {
    const head = Buffer.alloc(37); sha256(rpId).copy(head, 0); head[32] = flags; head.writeUInt32BE(count, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
    return Buffer.concat([head, Buffer.alloc(16), len, id, Buffer.from([0xa0])]);
  };
  const client = (type: string, challenge: Buffer, origin: string) => Buffer.from(JSON.stringify({ type, challenge: challenge.toString('base64url'), origin, crossOrigin: false }));
  const spki = (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');
  return {
    credentialId: id.toString('base64url'), publicKey: spki, alg,
    register: (challenge, origin, opts = {}) => ({ credentialId: id.toString('base64url'), publicKey: spki, alg,
      clientDataJSON: client('webauthn.create', challenge, origin).toString('base64url'),
      authenticatorData: auth(new URL(origin).hostname, opts.flags ?? 0x45, 0, true).toString('base64url') }),
    assert: (challenge, origin, opts = {}) => {
      const data = auth(opts.rpId ?? new URL(origin).hostname, opts.flags ?? 0x05, opts.counter ?? ++counter, false);
      const cd = client(opts.type ?? 'webauthn.get', challenge, origin);
      const signature = sign(alg === -8 ? null : 'sha256', Buffer.concat([data, sha256(cd)]), privateKey);
      return { credentialId: id.toString('base64url'), clientDataJSON: cd.toString('base64url'), authenticatorData: data.toString('base64url'), signature: signature.toString('base64url') };
    }
  };
}
