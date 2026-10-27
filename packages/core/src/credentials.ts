// ----------------------------------------------------------------------------
// Credential loading + persistence for the live KakaoTalk account.
//
// Credentials come from device registration (`npm run setup`, apps/mcp/src/register.ts)
// and live in .env.local (gitignored). The access_token is a rotating bearer, so
// when token refresh produces a new one we persist it back to .env.local so the
// next process start reuses it. Only the KAKAO_* keys we own are rewritten; any
// other lines in the file are preserved verbatim.
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import { setupCommand } from './entry.ts';
import path from 'node:path';
import { findEnvFile } from './env-file.ts';
import { loadConfig } from './config.ts';
import { KakaoError } from './errors.ts';

export interface KakaoCredentials {
  userId: string;
  accessToken: string;
  deviceUUID: string;
  /** Present when login returned it; required to attempt renewal-endpoint refresh. */
  refreshToken?: string;
  email?: string;
  /** Account password — enables refresh-via-re-login (login.json). Sensitive; .env.local only. */
  password?: string;
  /** Device name sent in the login body (KAKAO_DEVICE_NAME); defaults applied if absent. */
  deviceName?: string;
}

/**
 * Rewrite only the given KAKAO_* keys in `.env.local`, preserving every other line
 * (and comments) verbatim; missing keys are appended. Keys with a null/undefined value
 * are skipped. Written 0o600 and flushed. Failures throw instead of reporting an
 * unpersisted token as saved. Shared by runtime and first-time bootstrap.
 */
export function writeEnvKeys(envPath: string, kv: Record<string, string | undefined>): void {
  let lines: string[] = [];
  try {
    const stat = fs.lstatSync(envPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new KakaoError('STORAGE_UNSAFE', 'Unsafe credential file');
    lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new KakaoError('STORAGE_UNSAFE', 'Cannot read existing credential file');
  }
  const remaining = new Map(Object.entries(kv).filter(([, v]) => v != null) as [string, string][]);
  const owned = new Set(remaining.keys());
  const next = lines.map((line) => {
    const t = line.trim();
    const idx = t.indexOf('=');
    if (!t || t.startsWith('#') || idx === -1) return line;
    const key = t.slice(0, idx).trim();
    if (remaining.has(key)) {
      const v = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${v}`;
    }
    return owned.has(key) ? null : line;
  }).filter((line): line is string => line !== null);
  for (const [key, v] of remaining) next.push(`${key}=${v}`);
  try {
    const body = next.join('\n').replace(/\n+$/, '') + '\n';
    // The managed service may write only this file, not its root-owned parent.
    // Keep the inode and ownership; create no secret-bearing temporary copies.
    const fd = fs.openSync(envPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('unsafe');
      fs.fchmodSync(fd, 0o600); fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, body); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { throw new KakaoError('STORAGE_UNSAFE', 'Cannot persist account credentials'); }
}

export class CredentialStore {
  private readonly envPath: string;
  private creds: KakaoCredentials;
  private persistEncrypted?: (creds: KakaoCredentials) => void;

  private constructor(envPath: string, creds: KakaoCredentials) {
    this.envPath = envPath;
    this.creds = creds;
  }

  /**
   * Load credentials from `.env.local` (walked up from cwd) and/or process.env.
   * Tests can pin an explicit `.env.local` path via `opts.envPath` so persistence
   * never touches the real file; `opts.env` overrides which env map is consulted.
   */
  static load(opts: { envPath?: string; env?: Record<string, string | undefined> } = {}): CredentialStore {
    const { envPath, credentials } = loadConfig(opts);
    const { userId, accessToken, deviceUUID } = credentials;
    if (!userId || !accessToken || !deviceUUID) {
      throw new KakaoError(
        'CONFIG_INVALID',
        'Missing KAKAO_USER_ID / KAKAO_ACCESS_TOKEN / KAKAO_REGISTERED_DEVICE_UUID ' +
          `(looked in env and ${envPath}). Run ${setupCommand()} to register this device.`
      );
    }
    return new CredentialStore(envPath, { ...credentials, userId, accessToken, deviceUUID });
  }

  /** Hosted workers inject an encrypted persistence sink; never load process.env. */
  static encrypted(creds: KakaoCredentials, persist: (creds: KakaoCredentials) => void): CredentialStore {
    if (!/^\d+$/.test(creds.userId) || !creds.accessToken || !creds.deviceUUID) {
      throw new KakaoError('CONFIG_INVALID', 'Incomplete account credentials');
    }
    const store = new CredentialStore('', { ...creds });
    store.persistEncrypted = persist;
    return store;
  }

  get(): KakaoCredentials {
    return { ...this.creds };
  }

  /** Update the token(s) in memory and persist the changed KAKAO_* keys to .env.local. */
  update(patch: Partial<Pick<KakaoCredentials, 'accessToken' | 'refreshToken' | 'deviceUUID'>>): void {
    const previous = this.creds;
    this.creds = { ...previous, ...patch };
    try {
      this.persist({
        KAKAO_ACCESS_TOKEN: this.creds.accessToken,
        KAKAO_REFRESH_TOKEN: this.creds.refreshToken,
        KAKAO_REGISTERED_DEVICE_UUID: this.creds.deviceUUID
      });
    } catch (error) { this.creds = previous; throw error; }
  }

  private persist(kv: Record<string, string | undefined>): void {
    if (this.persistEncrypted) { this.persistEncrypted(this.get()); return; }
    writeEnvKeys(this.envPath, kv);
  }

  /** Human terminal configuration only; never exposed as an MCP mutation tool. */
  static saveLogin(envPath: string, email: string, password: string, maxAttempts = 3): void {
    CredentialStore.load({ envPath, env: {} }); // Existing account/device must already be registered.
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !email || !password || email.length > 8192 || password.length > 8192 || /[\x00-\x1f\x7f]/.test(email + password)) {
      throw new KakaoError('INVALID_ARGUMENT', 'Login data is empty or contains unsupported control characters');
    }
    writeEnvKeys(envPath, { KAKAO_EMAIL: email, KAKAO_PASSWORD: password, KAKAO_ENABLE_TOKEN_REFRESH: '1', KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS: String(maxAttempts) });
  }

  /** Resolve the `.env.local` path (walked up from `startDir`/cwd), even if absent. */
  static resolveEnvPath(startDir?: string): string {
    return findEnvFile(startDir);
  }

  /**
   * Read the OPTIONAL settings a first-time bootstrap needs (email / password / device
   * name) without requiring the mandatory login keys — unlike `load()`, this never throws
   * when the account is not yet registered. Returns the resolved `envPath` so the caller
   * can persist the registration result back to the same file.
   */
  static readOptional(
    opts: { envPath?: string; env?: Record<string, string | undefined> } = {}
  ): { email?: string; password?: string; deviceName?: string; envPath: string } {
    const { envPath, credentials: { email, password, deviceName } } = loadConfig(opts);
    return { email, password, deviceName, envPath };
  }

  /**
   * Persist a (possibly first-time) set of credentials to `.env.local`, preserving other
   * lines and comments. Used by the standalone device-registration bootstrap to write the
   * freshly-registered device key + tokens. The account password is deliberately NOT
   * written here — the bootstrap only preserves what the user already placed in the file.
   */
  static persistCredentials(
    envPath: string,
    creds: Partial<Pick<KakaoCredentials, 'userId' | 'accessToken' | 'refreshToken' | 'deviceUUID' | 'email' | 'deviceName'>>
  ): void {
    writeEnvKeys(envPath, {
      KAKAO_USER_ID: creds.userId,
      KAKAO_ACCESS_TOKEN: creds.accessToken,
      KAKAO_REFRESH_TOKEN: creds.refreshToken,
      KAKAO_REGISTERED_DEVICE_UUID: creds.deviceUUID,
      KAKAO_EMAIL: creds.email,
      KAKAO_DEVICE_NAME: creds.deviceName
    });
  }
}
