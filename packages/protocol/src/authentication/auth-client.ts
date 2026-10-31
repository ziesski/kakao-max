import crypto from 'node:crypto';

export interface AuthClientConfig {
  agent: string;
  version: string;
  osVersion: string;
  language: string;
  baseUrl: string;
  /** Android API level used in device registration, distinct from the OS release. */
  apiLevel?: string;
  model?: string;
}

export const DEFAULT_AUTH_CONFIG: AuthClientConfig = {
  agent: 'mac',
  version: '26.4.0',
  osVersion: '26.3.1', // macOS version
  language: 'ko',
  baseUrl: 'https://katalk.kakao.com'
};

export type DeviceType = 'pc' | 'tablet';

/** Experimental tablet identity; server compatibility still requires operator validation. */
export const TABLET_AUTH_CONFIG: AuthClientConfig = {
  agent: 'android', version: '25.9.2', osVersion: '13', apiLevel: '33',
  language: 'ko', baseUrl: 'https://katalk.kakao.com', model: 'SM-T870'
};
export function authConfigForDevice(type: DeviceType = 'pc'): AuthClientConfig {
  return { ...(type === 'tablet' ? TABLET_AUTH_CONFIG : DEFAULT_AUTH_CONFIG) };
}
export function calculateAndroidXVC(userAgent: string, email: string): string {
  return crypto.createHash('sha512').update(`BARD|${userAgent}|DANTE|${email}|SIAN`).digest('hex').slice(0, 16);
}

/**
 * User-Agent platform token, e.g. `KT/26.4.0 Mc/26.3.1 ko` — macOS uses `Mc`, Windows `Wd`.
 * This matters because X-VC hashes the exact User-Agent string.
 */
const AGENT_UA_TOKEN: Record<string, string> = { mac: 'Mc', win32: 'Wd', android: 'An', ios: 'iOS' };

export interface AuthResult<T = Record<string, unknown>> {
  status: number;
  message?: string;
  data?: T;
  raw: Record<string, unknown>;
  /** The exact, unparsed response body as returned by the server. */
  rawText: string;
  /** The HTTP status code of the response (distinct from the application-level `status`). */
  httpStatus: number;
}

export interface LoginSuccessData {
  userId: string;
  accessToken: string;
  refreshToken: string;
  countryIso: string;
  chatServerHost?: string;
  chatServerPort?: number;
}

export function calculateXVC(deviceUUID: string, userAgent: string, email: string): string {
  const source = `JAYDEN|${userAgent}|JAYMOND|${email}|${deviceUUID}`;
  return crypto.createHash('sha512').update(source).digest('hex').substring(0, 16);
}

export interface PasscodeGenerateData {
  passcode: string;
  remainingSeconds: number;
}

export interface TokenRenewalData {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
}

export interface RenewTokenOptions {
  /**
   * Account endpoint (relative to `/<agent>/account/`) that renews a bearer token.
   * UNVERIFIED default — pass the real value, or override via the `KAKAO_RENEWAL_ENDPOINT`
   * env at the call site.
   */
  endpoint?: string;
  /** Send the body as JSON instead of x-www-form-urlencoded. */
  json?: boolean;
}

export interface RenewTokenResult extends AuthResult<TokenRenewalData> {
  /** Convenience: the new tokens if the response carried them. */
  accessToken?: string;
  refreshToken?: string;
}

export class KakaoAuthClient {
  private config: AuthClientConfig;
  private deviceName: string;
  private deviceUUID: string;

  constructor(deviceName: string, deviceUUID: string, config: Partial<AuthClientConfig> = {}) {
    this.deviceName = deviceName;
    this.deviceUUID = deviceUUID;
    this.config = { ...(config.agent === 'android' ? TABLET_AUTH_CONFIG : DEFAULT_AUTH_CONFIG), ...config };
  }

  get userAgent(): string {
    const token = AGENT_UA_TOKEN[this.config.agent] ?? 'Mc';
    return `KT/${this.config.version} ${token}/${this.config.osVersion} ${this.config.language}`;
  }

  /**
   * Authorization header for authenticated katalk.kakao.com calls.
   * Format: `Authorization: <accessToken>-<deviceUuid>`.
   * The suffix is literally the device_uuid (a base64 device key), NOT an HMAC.
   */
  static authorization(accessToken: string, deviceUuid: string): string {
    return `${accessToken}-${deviceUuid}`;
  }

  private createHeaders(email: string, contentType = 'application/x-www-form-urlencoded'): Record<string, string> {
    const ua = this.userAgent;
    const xvc = this.config.agent === 'android' ? calculateAndroidXVC(ua, email) : calculateXVC(this.deviceUUID, ua, email);

    return {
      'A': `${this.config.agent}/${this.config.version}/${this.config.language}`,
      'User-Agent': ua,
      'X-VC': xvc,
      'Content-Type': contentType,
      'Accept': '*/*',
      'Accept-Language': this.config.language
    };
  }

  /**
   * Parse a fetch Response into an AuthResult, always preserving the exact raw body text
   * and HTTP status. A non-JSON body no longer throws: it is surfaced via `rawText` so the
   * caller can inspect the true schema (e.g. the approved-registration payload, which does
   * NOT carry an integer `status` field).
   */
  private async parseResponse<T>(url: string, res: Response): Promise<AuthResult<T>> {
    const rawText = await res.text();
    let json: Record<string, unknown> = {};
    let parseOk = true;
    try {
      json = JSON.parse(rawText);
    } catch {
      parseOk = false;
    }

    const status = parseOk && typeof json.status === 'number' ? json.status : res.status;
    const message = parseOk && typeof json.message === 'string' ? (json.message as string) : undefined;

    return {
      status,
      message,
      data: json as unknown as T,
      raw: json,
      rawText,
      httpStatus: res.status
    };
  }

  private async requestForm<T = Record<string, unknown>>(endpoint: string, email: string, formParams: Record<string, string>): Promise<AuthResult<T>> {
    const url = `${this.config.baseUrl}/${this.config.agent}/account/${endpoint}`;
    const headers = this.createHeaders(email, 'application/x-www-form-urlencoded');

    const body = new URLSearchParams({
      device_uuid: this.deviceUUID,
      device_name: this.deviceName,
      ...formParams
    });

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(15000)
    });

    return this.parseResponse<T>(url, res);
  }

  private async requestJson<T = Record<string, unknown>>(endpoint: string, email: string, jsonBody: Record<string, unknown>): Promise<AuthResult<T>> {
    const url = `${this.config.baseUrl}/${this.config.agent}/account/${endpoint}`;
    const headers = this.createHeaders(email, 'application/json');

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonBody),
      signal: AbortSignal.timeout(15000)
    });

    return this.parseResponse<T>(url, res);
  }

  /**
   * Public, generic POST to `/<agent>/account/<endpoint>` with arbitrary fields. Used by
   * flows whose body shape is still being pinned down (e.g. the sign-registration flow),
   * so they can pass field names directly. `device_uuid`/`device_name` are added
   * automatically for the form variant; set `authToken` to attach the authenticated
   * `Authorization: <token>-<deviceUuid>` header.
   */
  async postAccount<T = Record<string, unknown>>(
    endpoint: string,
    email: string,
    fields: Record<string, string>,
    opts: { json?: boolean; authToken?: string } = {}
  ): Promise<AuthResult<T>> {
    const url = `${this.config.baseUrl}/${this.config.agent}/account/${endpoint}`;
    const headers = this.createHeaders(email, opts.json ? 'application/json' : 'application/x-www-form-urlencoded');
    if (opts.authToken) headers.Authorization = KakaoAuthClient.authorization(opts.authToken, this.deviceUUID);
    const body = opts.json
      ? JSON.stringify(fields)
      : new URLSearchParams({ device_uuid: this.deviceUUID, device_name: this.deviceName, ...fields }).toString();
    const res = await fetch(url, { method: 'POST', headers, body });
    return this.parseResponse<T>(url, res);
  }

  /**
   * Attempt primary login with email and password
   */
  async login(email: string, password: string, forced = false, permanent = true): Promise<AuthResult<LoginSuccessData>> {
    if (this.config.agent === 'android') {
      return this.requestForm<LoginSuccessData>('login.json', email, {
        email, password, model_name: this.config.model ?? 'SM-T870',
        permanent: String(permanent), forced: String(forced)
      });
    }
    // Body: device_name, device_uuid, email, os_version, password, permanent=1. Takeover is a separate explicit opt-in.
    return this.requestForm<LoginSuccessData>('login.json', email, {
      email,
      password,
      os_version: this.config.osVersion,
      permanent: permanent ? '1' : '0',
      ...(forced === true ? { forced: 'true' } : {})
    });
  }

  /**
   * Request / Generate a 4-digit verification passcode for device registration (Modern KakaoTalk Mac flow).
   * Displays the 4-digit passcode to be entered in the mobile KakaoTalk app under:
   * Settings -> Device Management -> Register PC
   */
  async generatePasscode(email: string, password: string, permanent = true): Promise<AuthResult<PasscodeGenerateData>> {
    return this.requestJson<PasscodeGenerateData>('passcodeLogin/generate', email, {
      email,
      password,
      device: {
        name: this.deviceName,
        uuid: this.deviceUUID,
        osVersion: this.config.apiLevel ?? this.config.osVersion,
        model: this.config.model ?? 'MacBookPro'
      },
      permanent
    });
  }

  /**
   * Backward compatibility alias for generatePasscode
   */
  async requestPasscode(email: string, password: string): Promise<AuthResult<PasscodeGenerateData>> {
    return this.generatePasscode(email, password);
  }

  /**
   * Poll / check whether device registration was approved on mobile device (Modern KakaoTalk Mac flow).
   *
   * Sends the FULL device object (name/uuid/osVersion/model), matching `generate`. Polling with
   * only `device: {uuid}` returned a bare `{"status":-500}` the instant the passcode was approved
   * on the phone (a terminal branch, not the rich `-100` pending body), then `{"status":-110}`.
   * The poll must present the same device identity it registered — a partial object cannot be
   * correlated to the phone approval.
   */
  async registerDevice(email: string, password: string): Promise<AuthResult> {
    return this.requestJson('passcodeLogin/registerDevice', email, {
      email,
      password,
      device: {
        name: this.deviceName,
        uuid: this.deviceUUID,
        osVersion: this.config.apiLevel ?? this.config.osVersion,
        model: this.config.model ?? 'MacBookPro'
      },
      permanent: true
    });
  }

  /**
   * Renew a rotating bearer `access_token` using the `refresh_token` returned by login.
   *
   * STATUS: the renewal endpoint + body shape are NOT yet verified. This implements the call
   * against the most likely shape — an authenticated POST carrying the access + refresh tokens
   * and the device key — so a confirmed endpoint/body is a one-line change (or an env/arg
   * override). Until then callers should gate invocation behind an explicit opt-in and fall
   * back to re-login on failure.
   */
  async renewToken(
    email: string,
    accessToken: string,
    refreshToken: string,
    opts: RenewTokenOptions = {}
  ): Promise<RenewTokenResult> {
    const endpoint = opts.endpoint ?? 'renewal.json';
    const fields: Record<string, string> = {
      access_token: accessToken,
      refresh_token: refreshToken,
      os_version: this.config.osVersion
    };
    const base = await this.postAccount<TokenRenewalData>(endpoint, email, fields, {
      json: opts.json,
      authToken: accessToken
    });
    const data = base.data ?? {};
    return {
      ...base,
      accessToken: typeof data.access_token === 'string' ? data.access_token : undefined,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined
    };
  }

  /**
   * Cancel passcode registration flow
   */
  async cancelPasscode(email: string, password: string): Promise<AuthResult> {
    return this.requestJson('passcodeLogin/cancel', email, {
      email,
      password,
      device: {
        uuid: this.deviceUUID
      }
    });
  }

  /**
   * Renew OAuth credentials using refresh token via `/mac/account/oauth2_token.json`.
   * Verified against live server: returns fresh access_token and rotated refresh_token.
   */
  async refreshToken(accessToken: string, refreshToken: string): Promise<AuthResult<LoginSuccessData>> {
    const url = `${this.config.baseUrl}/${this.config.agent}/account/oauth2_token.json`;
    const headers = {
      'A': `${this.config.agent}/${this.config.version}/${this.config.language}`,
      'User-Agent': this.userAgent,
      'Authorization': KakaoAuthClient.authorization(accessToken, this.deviceUUID),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      'Accept-Language': this.config.language
    };

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      access_token: accessToken,
      refresh_token: refreshToken
    });

    const tablet = this.config.agent === 'android';
    if (tablet) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      Object.assign(headers, { C: crypto.randomUUID(), Connection: 'Close' });
    }
    const res = await fetch(url, {
      method: 'POST', headers,
      body: tablet ? JSON.stringify(Object.fromEntries(body)) : body.toString(),
      signal: AbortSignal.timeout(15000)
    });

    const parsed = await this.parseResponse<Record<string, unknown>>(url, res);
    const data = parsed.data || {};
    const successData: LoginSuccessData | undefined = parsed.status === 0 ? {
      userId: typeof data.userId === 'string' ? data.userId : '',
      accessToken: typeof data.access_token === 'string' ? data.access_token : '',
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
      countryIso: typeof data.countryIso === 'string' ? data.countryIso : 'KR'
    } : undefined;

    return {
      ...parsed,
      data: successData
    };
  }
}
