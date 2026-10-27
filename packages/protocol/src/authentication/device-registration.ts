import crypto from 'node:crypto';
import { KakaoAuthClient, type AuthClientConfig, type AuthResult, type LoginSuccessData } from './auth-client.js';

// ----------------------------------------------------------------------------
// Standalone device registration — sign flow verified against a live registration.
// Explicit sign=false uses the existing Mac passcode methods with a human callback (unit-tested; live E2E pending).
//
// GOAL: register a brand-new device directly against katalk.kakao.com with its own device key.
//
// The flow is a PHONE-APPROVAL handshake, all x-www-form-urlencoded with the same auth headers:
//
//   1. POST login.json  { device_name, device_uuid, email, password, os_version, permanent }
//        -> status -100, body has `registerDeviceWithSign`  (device not registered)
//   2. POST request_sign.json  { device_name, device_uuid, email, password, permanent }
//        -> status 0, { os_name: "ios", interval: 5, expire_after: 5 }
//        (this pushes an approval prompt to the account's main device / phone)
//   3. POST confirm_sign.json  { device_name, device_uuid, email, password, permanent }   (poll every `interval`s)
//        -> status -142 while PENDING ... -> status 0 once APPROVED on the phone
//   4. POST login.json (again) -> status 0 + { access_token, refresh_token, userId }
//
// There is NO publicKey, RSA signature, authCode, or commit id at the HTTP layer; the
// registration is correlated purely by (email, device_uuid). `device_uuid` is a 52-byte
// random value, standard-base64 encoded (~72 chars).
// ----------------------------------------------------------------------------

/** login.json status when the device must be registered via the sign flow. */
export const STATUS_NEEDS_SIGN = -100;
/** confirm_sign.json status while still awaiting phone approval. */
export const STATUS_CONFIRM_PENDING = -142;

/**
 * Generate a fresh KakaoTalk `device_uuid`: 52 random bytes, standard base64, matching
 * the expected device key format (~72 chars). This is the device identity;
 * persist it securely alongside the issued tokens.
 */
export function generateDeviceUuid(byteLength = 52): string {
  return crypto.randomBytes(byteLength).toString('base64');
}

export interface AwaitingApprovalInfo {
  /** The device that must approve, e.g. "ios" (the account's main phone). */
  osName?: string;
  /** Minutes the approval window stays open (server `expire_after`). */
  expireAfter?: number;
  /** Server-suggested poll interval, seconds. */
  interval?: number;
}

export type RegistrationStage = 'initial_login' | 'request_sign' | 'confirm_sign' | 'final_login' | 'takeover_login' | 'generate_passcode' | 'register_device';
export interface RegistrationTrace {
  stage: RegistrationStage;
  status?: number;
  httpStatus?: number;
  /** Initial login's registration flag only; no upstream free text or identifiers. */
  signRegistration?: 'enabled' | 'disabled' | 'absent' | 'invalid';
}

export interface SignRegistrationOptions {
  /** Explicit user consent to sign out the other PC; never enabled by reconnect. */
  confirmTakeover?: boolean;
  /** Numeric response metadata and a closed registration-flag state; never raw fields. */
  onResponse?: (trace: RegistrationTrace) => void;
  /** Human terminal callback for the alternate passcode flow; never a log/trace sink. */
  onPasscode?: (info: { passcode: string; remainingSeconds: number }) => void;
  /** Override the server-suggested poll interval (seconds). */
  pollIntervalSec?: number;
  /** Max time to wait for phone approval (seconds). Default: server expire_after*60, else 300. */
  timeoutSec?: number;
  /** Called once the approval push has been sent, so a UI can tell the user to approve on their phone. */
  onAwaitingApproval?: (info: AwaitingApprovalInfo) => void;
  /** Called before each pending poll. */
  onPoll?: (attempt: number) => void;
}

export interface SignRegistrationResult {
  /** Final status (0 = registered + logged in). */
  status: number;
  /** The device_uuid that is now registered (generated or supplied) — persist it. */
  deviceUuid: string;
  /** The final login result, when registration succeeded. */
  login?: AuthResult<LoginSuccessData>;
  /** Convenience: fresh credentials from the final login. */
  credentials?: { userId?: string; accessToken?: string; refreshToken?: string };
  /** Human-readable note on failure (timeout / rejected). */
  message?: string;
  failure?: 'unsupported-method' | 'malformed-response';
}

function extractCredentials(res: AuthResult<LoginSuccessData>) {
  const raw = res.raw as Record<string, any>;
  return {
    userId: raw.userId != null ? String(raw.userId) : undefined,
    accessToken: typeof raw.access_token === 'string' ? raw.access_token : undefined,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drives standalone device registration via the verified sign (phone-approval)
 * flow. Generates a fresh device_uuid unless one is supplied, then:
 * login -> (if unregistered) request_sign -> poll confirm_sign until the user approves on
 * their phone -> login again for tokens.
 */
export class KakaoDeviceRegistration {
  readonly deviceUuid: string;
  readonly deviceName: string;
  private readonly auth: KakaoAuthClient;

  constructor(deviceName: string, config: Partial<AuthClientConfig> = {}, deviceUuid?: string) {
    this.deviceName = deviceName;
    this.deviceUuid = deviceUuid ?? generateDeviceUuid();
    this.auth = new KakaoAuthClient(deviceName, this.deviceUuid, config);
  }

  /** Respect the explicit server flag: sign=true; passcode=false with a human UI. Unknown flags stop. */
  async register(email: string, password: string, opts: SignRegistrationOptions = {}): Promise<SignRegistrationResult> {
    let signRegistration: RegistrationTrace['signRegistration'];
    const observe = async <T extends AuthResult<any>>(stage: RegistrationStage, request: () => Promise<T>): Promise<T> => {
      opts.onResponse?.({ stage, ...(signRegistration ? { signRegistration } : {}) });
      const result = await request();
      if (stage === 'initial_login') {
        const raw = result.raw;
        signRegistration = !Object.prototype.hasOwnProperty.call(raw, 'registerDeviceWithSign') ? 'absent'
          : raw.registerDeviceWithSign === true ? 'enabled'
          : raw.registerDeviceWithSign === false ? 'disabled' : 'invalid';
      }
      opts.onResponse?.({ stage, status: result.status, httpStatus: result.httpStatus, ...(signRegistration ? { signRegistration } : {}) });
      return result;
    };
    let takeoverAttempted = false;
    const login = async (stage: 'initial_login' | 'final_login') => {
      const result = await observe(stage, () => this.auth.login(email, password));
      // A single conflict retry, only after explicit consent for this registration.
      // Phone approval and all other failures keep their ordinary semantics.
      if (result.status !== -101 || opts.confirmTakeover !== true || takeoverAttempted) return result;
      takeoverAttempted = true;
      return observe('takeover_login', () => this.auth.login(email, password, true));
    };
    // 1. Initial login — already registered devices get tokens straight away.
    const first = await login('initial_login');
    if (first.status === 0) {
      return { status: 0, deviceUuid: this.deviceUuid, login: first, credentials: extractCredentials(first) };
    }
    if (first.status !== STATUS_NEEDS_SIGN) {
      return { status: first.status, deviceUuid: this.deviceUuid, message: `login failed (status ${first.status})` };
    }


    if (signRegistration === 'disabled') {
      // Existing Mac passcode endpoints; this branch still needs live E2E evidence.
      // Do not generate a code unless the caller can show it directly to the human.
      if (!opts.onPasscode) return { status: first.status, deviceUuid: this.deviceUuid,
        failure: 'unsupported-method', message: 'This account requires a passcode-capable registration client' };
      const generated = await observe('generate_passcode', () => this.auth.generatePasscode(email, password));
      if (generated.status !== 0) return { status: generated.status, deviceUuid: this.deviceUuid, message: 'Passcode generation failed' };
      const code = generated.raw.passcode, remaining = generated.raw.remainingSeconds;
      if (typeof code !== 'string' || !/^\d{4}$/.test(code) || typeof remaining !== 'number' ||
          !Number.isFinite(remaining) || remaining <= 0 || remaining > 600) {
        return { status: first.status, deviceUuid: this.deviceUuid, failure: 'malformed-response', message: 'Invalid passcode response; registration stopped' };
      }
      const timeout = opts.timeoutSec ?? remaining, interval = opts.pollIntervalSec ?? 3;
      if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(interval) || interval < 0 || interval > 30) {
        return { status: first.status, deviceUuid: this.deviceUuid, failure: 'malformed-response', message: 'Invalid passcode timing; registration stopped' };
      }
      const deadline = Date.now() + Math.min(timeout, remaining) * 1000;
      if (Date.now() >= deadline) return { status: STATUS_CONFIRM_PENDING, deviceUuid: this.deviceUuid, message: 'Passcode approval timed out' };
      opts.onPasscode({ passcode: code, remainingSeconds: remaining });
      let attempt = 0;
      for (;;) {
        if (Date.now() >= deadline) return { status: STATUS_CONFIRM_PENDING, deviceUuid: this.deviceUuid, message: 'Passcode approval timed out' };
        const registered = await observe('register_device', () => this.auth.registerDevice(email, password));
        if (registered.status === 0) break;
        if (registered.status !== STATUS_NEEDS_SIGN) return { status: registered.status, deviceUuid: this.deviceUuid, message: 'Passcode registration rejected' };
        opts.onPoll?.(++attempt);
        const next = registered.raw.nextRequestIntervalInSeconds;
        const waitSeconds = opts.pollIntervalSec ?? (typeof next === 'number' && Number.isFinite(next) && next >= 1 && next <= 30 ? next : interval);
        await delay(Math.min(waitSeconds * 1000, Math.max(0, deadline - Date.now())));
      }
      const final = await login('final_login');
      return { status: final.status, deviceUuid: this.deviceUuid, login: final, credentials: extractCredentials(final) };
    }
    if (signRegistration !== 'enabled') return { status: first.status, deviceUuid: this.deviceUuid,
      failure: 'unsupported-method', message: 'Server did not explicitly select a supported registration method' };

    // 2. request_sign — triggers the approval push to the account's main device.
    const req = await observe('request_sign', () => this.auth.postAccount('request_sign.json', email, { email, password, permanent: '1' }));
    if (req.status !== 0) {
      return { status: req.status, deviceUuid: this.deviceUuid, message: `request_sign failed (status ${req.status})` };
    }
    const raw = req.raw as Record<string, any>;
    const interval = typeof raw.interval === 'number' ? raw.interval : 5;
    const expireAfter = typeof raw.expire_after === 'number' ? raw.expire_after : 5;
    opts.onAwaitingApproval?.({ osName: raw.os_name, expireAfter, interval });

    // 3. Poll confirm_sign until the user approves on their phone (status 0) or we time out.
    const pollMs = (opts.pollIntervalSec ?? interval) * 1000;
    const deadline = Date.now() + (opts.timeoutSec ?? expireAfter * 60) * 1000;
    let attempt = 0;
    for (;;) {
      const conf = await observe('confirm_sign', () => this.auth.postAccount('confirm_sign.json', email, { email, password, permanent: '1' }));
      if (conf.status === 0) break; // approved
      if (conf.status !== STATUS_CONFIRM_PENDING) {
        return { status: conf.status, deviceUuid: this.deviceUuid, message: `confirm_sign rejected (status ${conf.status})` };
      }
      if (Date.now() >= deadline) {
        return { status: STATUS_CONFIRM_PENDING, deviceUuid: this.deviceUuid, message: 'approval timed out' };
      }
      opts.onPoll?.(++attempt);
      await delay(pollMs);
    }

    // 4. Final login now yields tokens for the freshly-registered device.
    const final = await login('final_login');
    return {
      status: final.status,
      deviceUuid: this.deviceUuid,
      login: final,
      credentials: extractCredentials(final)
    };
  }
}
