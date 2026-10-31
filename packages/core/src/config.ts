// ----------------------------------------------------------------------------
// Runtime configuration for the account runtime, resolved once at startup.
//
// Sources, highest priority first: process.env, then .env.local. Every setting
// has a safe default; invalid values fail fast with CONFIG_INVALID instead of
// being silently ignored.
//
//   KAKAO_DATA_DIR             local data directory (default ~/.kakao-max, fallback ~/.kakao)
//   KAKAO_APP_VERSION          KakaoTalk client version we present (default 26.4.0).
//                              Raise it when Kakao rejects old clients.
//   KAKAO_DEVICE_TYPE          pc (default) or experimental tablet; new registrations only
//   KAKAO_REGISTERED_DEVICE_TYPE identity bound to saved credentials (legacy: pc)
//   KAKAO_CLIENT_OS            must match the selected identity: mac or android
//   KAKAO_LANG                 client language (default ko)
//   KAKAO_TIMEZONE             IANA time zone sent to profile APIs (default Asia/Seoul)
//   KAKAO_ENABLE_TOKEN_REFRESH truthy → refresh credentials on auth failure
//   KAKAO_RENEWAL_ENDPOINT     override for the (unverified) token renewal endpoint
//   KAKAO_RECORD_FILE          record sanitized LOCO frames here (replay fixtures; off by default)
//   KAKAO_ADD_FRIEND_DAILY_LIMIT  friends add_friend may add per local day, in every mode (default 10, 1–100)
//   KAKAO_MCP_ALLOWED_UIDS     OS users whose loopback MCP TCP connections are served, besides the daemon's own and root
//                              (Linux; comma-separated uids). setup records the installing operator here.
//
// Credentials (KAKAO_USER_ID, tokens, password) are loaded separately by
// CredentialStore, and outbound policy by loadPolicyConfig.
// ----------------------------------------------------------------------------

import { authConfigForDevice, type DeviceType } from '@kakao-max/protocol';
import type { PolicyConfig } from './policy.ts';
import type { KakaoCredentials } from './credentials.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEnvFile, readEnvFile } from './env-file.ts';
import { KakaoError } from './errors.ts';
import { AGENT_MODES, type AgentMode } from './agent-mode.ts';

// PC remains the default; Android tablet support is experimental.
export type ClientOs = 'mac' | 'android';

export interface KakaoConfig {
  /** Secrets: never log or serialize the complete configuration. */
  credentials: Partial<KakaoCredentials>;
  policy: PolicyConfig;
  healthTimeoutMs: number;
  /** CLI daemon endpoint (MCP_HOST / MCP_PORT). */
  mcpHost: string;
  mcpPort: number;
  /** Optional local MCP socket; absent means stdio. */
  mcpListen?: string;
  /** OS users (besides the daemon's own and root) whose loopback TCP connections are served (KAKAO_MCP_ALLOWED_UIDS). */
  mcpAllowedUids: number[];
  /** Optional MCP tool groups to list beyond the core tools (KAKAO_MCP_TOOL_GROUPS, comma-separated). */
  mcpToolGroups: McpToolGroup[];
  /** Policy defaults (KAKAO_AGENT_MODE): `ask` unless the operator chose `trust`. */
  agentMode: AgentMode;
  /** Whether the mode came from the settings or is the default, for get_status. */
  agentModeSource: 'setting' | 'default';
  /** Unapproved sends per allowed room per day. `null` = no daily cap (trust without an explicit limit). */
  recipientDailyLimit: number | null;
  /** add_friend calls per local day (KAKAO_TIMEZONE), approved or not, in every mode. Bounds bulk friend-add spam. */
  addFriendDailyLimit: number;
  /** Highest automation risk tier jobs may use (KAKAO_AUTOMATION_MAX_TIER); defaults by mode. */
  automationMaxTier: number;
  /** Optional local passkey approval page. Disabled unless both listen and origin are set. */
  approval: { listen?: string; origin?: string; notify: boolean;
    /** Minutes from prepare until approval must happen (5–30): default and per-action overrides. */
    windowMinutes: number; actionWindowMinutes: Record<string, number>;
    /** Accept the MCP client's own confirmation dialog (2026-07-28 elicitation) as approval. Default on. */
    clientConfirm: boolean };
  dataDir: string;
  /** The .env.local in use (credentials are persisted back here). */
  envPath: string;
  client: {
    appVersion: string;
    os: ClientOs;
    lang: string;
    timeZone: string;
  };
  tokenRefresh: {
    enabled: boolean;
    renewalEndpoint?: string;
    /** At most three ordinary login attempts per 24 hours, durable across restarts. */
    maxAttempts?: number;
  };
  /** When set, sanitized LOCO frames are appended here (see frame-recorder.ts). */
  recordFile?: string;
  vaultAutoSave: boolean;
  vaultMaxBytes?: number;
  vaultMinFreeBytes: number;
  vaultDownloadDelayMs: number;
}

export const DEFAULT_APP_VERSION = '26.4.0';

/**
 * The approval listener binds loopback only; remote phones reach it through an HTTPS proxy
 * (e.g. Tailscale serve) whose exact origin is configured, since WebAuthn binds to that origin.
 */
export function parseApprovalConfig(listen: string | undefined, origin: string | undefined, notify: string | undefined,
  windowMinutes?: string, actionWindows?: string, clientConfirm?: string): KakaoConfig['approval'] {
  const l = listen?.trim() || undefined, o = origin?.trim() || undefined;
  const notifyOn = notify === undefined || !['0', 'false', 'no', 'off'].includes(notify.trim().toLowerCase());
  const minutes = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 5 && x <= 30;
  const fallback = windowMinutes === undefined || !windowMinutes.trim() ? 15 : Number(windowMinutes.trim());
  if (!minutes(fallback)) throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_WINDOW_MINUTES must be a whole number from 5 to 30');
  let overrides: Record<string, number> = {};
  if (actionWindows?.trim()) {
    try { overrides = JSON.parse(actionWindows); } catch { throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_WINDOWS must be a JSON object of action → minutes'); }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) ||
        Object.entries(overrides).some(([k, v]) => !/^[a-z][a-z_]{0,63}$/.test(k) || !minutes(v))) {
      throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_WINDOWS must map action names to whole minutes from 5 to 30');
    }
  }
  const off = (v: string | undefined) => v !== undefined && ['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
  const windows = { windowMinutes: fallback, actionWindowMinutes: { ...overrides }, clientConfirm: !off(clientConfirm) };
  if (!l && !o) return { notify: notifyOn, ...windows };
  if (!l || !o) throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_LISTEN and KAKAO_APPROVAL_ORIGIN must be set together');
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(l);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_LISTEN must be a loopback host:port');
  let u: URL;
  try { u = new URL(o); } catch { throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_ORIGIN must be an origin URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.origin !== o || !(u.protocol === 'https:' || u.protocol === 'http:' && local)) {
    throw new KakaoError('CONFIG_INVALID', 'KAKAO_APPROVAL_ORIGIN must be an exact https origin, or http on localhost');
  }
  return { listen: l, origin: o, notify: notifyOn, ...windows };
}

/** Optional tool groups built into the MCP app. Other names belong to optional modules; the app refuses one that is not installed. */
export const MCP_TOOL_GROUPS = ['chats', 'friends', 'events', 'vault'] as const;
export type McpToolGroup = string;
export function parseMcpToolGroups(raw: string | undefined): McpToolGroup[] {
  const groups = [...new Set((raw ?? '').split(/[,\s]+/).map(g => g.trim().toLowerCase()).filter(Boolean))];
  const bad = groups.filter(g => !/^[a-z][a-z0-9-]{0,31}$/.test(g));
  if (bad.length) throw new KakaoError('CONFIG_INVALID', `KAKAO_MCP_TOOL_GROUPS has invalid group names (${bad.join(', ')}); choose from ${MCP_TOOL_GROUPS.join(', ')} or an installed optional module`);
  return groups;
}
/** An explicit limit always applies; without one, ask caps at 50 a day and trust has no daily cap. */
export function parseRecipientLimit(raw: string | undefined, mode: AgentMode = 'ask'): number | null {
  if (raw === undefined || !raw.trim()) return mode === 'trust' ? null : 50;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new KakaoError('CONFIG_INVALID', 'KAKAO_RECIPIENT_DAILY_LIMIT must be a whole number from 1 to 500');
  return n;
}
/** Friend adds per day: 10 unless set; trust mode does not lift it. */
export function parseAllowedUids(raw: string | undefined): number[] {
  const ids = (raw ?? '').split(/[,\s]+/).filter(Boolean);
  if (ids.some(id => !/^\d{1,10}$/.test(id))) throw new KakaoError('CONFIG_INVALID', 'KAKAO_MCP_ALLOWED_UIDS must list numeric OS user ids');
  return [...new Set(ids.map(Number))];
}

export function parseAddFriendLimit(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return 10;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new KakaoError('CONFIG_INVALID', 'KAKAO_ADD_FRIEND_DAILY_LIMIT must be a whole number from 1 to 100');
  return n;
}
export function parseAgentMode(raw: string | undefined): { mode: AgentMode; source: 'setting' | 'default' } {
  if (raw === undefined || !raw.trim()) return { mode: 'ask', source: 'default' };
  const mode = raw.trim().toLowerCase();
  if (!(AGENT_MODES as readonly string[]).includes(mode)) throw new KakaoError('CONFIG_INVALID', `KAKAO_AGENT_MODE must be ${AGENT_MODES.join(' or ')}`);
  return { mode: mode as AgentMode, source: 'setting' };
}
function parseAutomationTier(raw: string | undefined, mode: AgentMode): number {
  if (raw === undefined || !raw.trim()) return mode === 'trust' ? 3 : 1;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 3) throw new KakaoError('CONFIG_INVALID', 'KAKAO_AUTOMATION_MAX_TIER must be a whole number from 0 to 3');
  return n;
}

/** Approval window lookup for the operation services. */
export function approvalWindowFromConfig(a: KakaoConfig['approval']): (action: string) => number {
  return action => (a.actionWindowMinutes[action] ?? a.windowMinutes) * 60_000;
}
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const REMOVED_SETTINGS: ReadonlyArray<[string, string]> = [
  ['KAKAO_MCP_PERMISSION_MODEL', 'room permissions are the only model'],
  ['KAKAO_MCP_PROFILE', 'there is one tool list; enable optional groups with KAKAO_MCP_TOOL_GROUPS'],
  ['KAKAO_AGENT_APPROVAL_PUBLIC_KEY_FILE', 'the offline signer was removed; approve in the MCP client dialog or on the passkey page'],
];
/** Removed setting names present in `values`; the daemon refuses to start while any remain. */
export function removedSettingsIn(values: Record<string, string | undefined>): string[] {
  return REMOVED_SETTINGS.map(([key]) => key).filter(key => values[key] !== undefined);
}

let loggedLegacyDataDirNotice = false;

export function resetLegacyDataDirNoticeForTests(): void {
  loggedLegacyDataDirNotice = false;
}

function resolveDataDir(explicitDir: string | undefined, home: string): string {
  if (explicitDir) return path.resolve(explicitDir);
  const newDefault = path.join(home, '.kakao-max');
  const legacyDefault = path.join(home, '.kakao');
  if (!fs.existsSync(newDefault) && fs.existsSync(legacyDefault)) {
    if (!loggedLegacyDataDirNotice) {
      loggedLegacyDataDirNotice = true;
      console.error('[kakao-max] Using the legacy data directory; migrate it to ~/.kakao-max when convenient.');
    }
    return legacyDefault;
  }
  return newDefault;
}

export function loadConfig(opts: { envPath?: string; env?: Record<string, string | undefined>; homedir?: string } = {}): KakaoConfig {
  const envPath = opts.envPath ?? findEnvFile();
  const source = opts.env ?? process.env;
  const file = readEnvFile(envPath);
  const pick = (k: string): string | undefined => {
    const v = source[k] ?? file[k];
    return v === undefined || v === '' ? undefined : v;
  };

  const requestedType = pick('KAKAO_DEVICE_TYPE');
  const boundType = pick('KAKAO_REGISTERED_DEVICE_TYPE');
  for (const value of [requestedType, boundType]) if (value !== undefined && value !== 'pc' && value !== 'tablet') {
    throw new KakaoError('CONFIG_INVALID', 'Device type must be pc or tablet');
  }
  // Old credentials are PC credentials. Changing a selector must never reinterpret a key.
  const hasCredentials = ['KAKAO_REGISTERED_DEVICE_UUID', 'KAKAO_ACCESS_TOKEN', 'KAKAO_REFRESH_TOKEN', 'KAKAO_USER_ID'].some(k => pick(k) !== undefined);
  const deviceType = (requestedType ?? boundType ?? 'pc') as DeviceType;
  if ((hasCredentials && deviceType !== (boundType ?? 'pc')) || (boundType && requestedType && boundType !== requestedType)) {
    throw new KakaoError('CONFIG_INVALID', 'Device type differs from registered credentials. Register a fresh identity in a separate configuration; do not relabel existing keys.');
  }
  if (deviceType === 'tablet' && pick('KAKAO_REGISTERED_DEVICE_UUID') && !/^[a-f0-9]{64}$/.test(pick('KAKAO_REGISTERED_DEVICE_UUID')!)) {
    throw new KakaoError('CONFIG_INVALID', 'Tablet credentials require their own 64-character hexadecimal device key');
  }
  const profile = authConfigForDevice(deviceType);
  const appVersion = pick('KAKAO_APP_VERSION') ?? profile.version;
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) {
    throw new KakaoError('CONFIG_INVALID', `KAKAO_APP_VERSION must look like 26.4.0, got "${appVersion}"`);
  }
  const clientOs = (pick('KAKAO_CLIENT_OS') ?? profile.agent) as ClientOs;
  if (clientOs !== profile.agent) {
    throw new KakaoError('CONFIG_INVALID', `KAKAO_CLIENT_OS must be one of ${profile.agent}, got "${clientOs}"`);
  }
  const lang = pick('KAKAO_LANG') ?? 'ko';
  if (!/^[a-z]{2}$/.test(lang)) {
    throw new KakaoError('CONFIG_INVALID', `KAKAO_LANG must be a 2-letter code, got "${lang}"`);
  }

  const timeZone = pick('KAKAO_TIMEZONE') ?? 'Asia/Seoul';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new KakaoError('CONFIG_INVALID', `KAKAO_TIMEZONE must be an IANA time zone like Asia/Seoul, got "${timeZone}"`);
  }

  // Removed settings fail closed so an operator never believes an old setting still applies.
  for (const [key, why] of REMOVED_SETTINGS) {
    if (pick(key) !== undefined) throw new KakaoError('CONFIG_INVALID', `${key} was removed: ${why}. Delete this line from ${envPath}.`);
  }

  const ceiling = [...new Set((pick('KAKAO_ROOM_CEILING') ?? '').split(/[,;\s]+/).filter(Boolean))];
  if (ceiling.some(id => !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n))
    throw new KakaoError('CONFIG_INVALID', 'KAKAO_ROOM_CEILING must list numeric room IDs');
  if (pick('KAKAO_ALLOWED_CHAT_IDS') !== undefined)
    throw new KakaoError('CONFIG_INVALID', 'KAKAO_ALLOWED_CHAT_IDS was replaced by human room permission; use KAKAO_ROOM_CEILING for operator limits');
  const count = (key: string, fallback: number) => {
    const raw = pick(key), n = raw === undefined ? fallback : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const healthTimeoutMs = Number(pick('KAKAO_MCP_HEALTH_TIMEOUT_MS') ?? 5000);
  if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1 || healthTimeoutMs > 120000) throw new KakaoError('CONFIG_INVALID', 'Health timeout must be from 1 to 120000 milliseconds');
  const mcpHost = pick('MCP_HOST')?.trim() || '127.0.0.1';
  if (/[/\\\s?#@]/.test(mcpHost)) throw new KakaoError('CONFIG_INVALID', 'MCP_HOST must be a hostname or IP address');
  const mcpPort = Number(pick('MCP_PORT') ?? 8787);
  if (!Number.isSafeInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535) throw new KakaoError('CONFIG_INVALID', 'MCP_PORT must be a whole number from 1 to 65535');
  const agentMode = parseAgentMode(pick('KAKAO_AGENT_MODE'));
  const vaultAutoSave = TRUTHY.has((pick('KAKAO_VAULT_AUTO_SAVE') ?? '').toLowerCase());
  // Daemon feature flags that archive content are a trust-mode choice (design §4).
  if (vaultAutoSave && agentMode.mode !== 'trust') {
    throw new KakaoError('CONFIG_INVALID', `KAKAO_VAULT_AUTO_SAVE needs KAKAO_AGENT_MODE=trust; set it, or delete KAKAO_VAULT_AUTO_SAVE from ${envPath}.`);
  }
  return {
    credentials: {
      userId: pick('KAKAO_USER_ID'), accessToken: pick('KAKAO_ACCESS_TOKEN'), deviceUUID: pick('KAKAO_REGISTERED_DEVICE_UUID'),
      refreshToken: pick('KAKAO_REFRESH_TOKEN'), email: pick('KAKAO_EMAIL'), password: pick('KAKAO_PASSWORD'), deviceName: pick('KAKAO_DEVICE_NAME'), deviceType
    },
    policy: {
      notifyChatId: pick('KAKAO_NOTIFY_CHAT_ID'), ceiling,
      auditLogPath: path.resolve(pick('KAKAO_AUDIT_LOG') ?? path.join(path.dirname(envPath), 'kakao-mcp-audit.log')),
      pausedAtStart: TRUTHY.has((pick('KAKAO_PAUSED') ?? '').toLowerCase()),
      rateLimit: { windowMs: Math.max(1, count('KAKAO_RATE_WINDOW_SEC', 60)) * 1000,
        perChat: count('KAKAO_RATE_PER_CHAT', 5), global: count('KAKAO_RATE_GLOBAL', 15) }
    },
    healthTimeoutMs, mcpHost, mcpPort,
    mcpListen: pick('KAKAO_MCP_LISTEN')?.trim() || undefined,
    mcpAllowedUids: parseAllowedUids(pick('KAKAO_MCP_ALLOWED_UIDS')),
    mcpToolGroups: parseMcpToolGroups(pick('KAKAO_MCP_TOOL_GROUPS')),
    agentMode: agentMode.mode, agentModeSource: agentMode.source,
    recipientDailyLimit: parseRecipientLimit(pick('KAKAO_RECIPIENT_DAILY_LIMIT'), agentMode.mode),
    addFriendDailyLimit: parseAddFriendLimit(pick('KAKAO_ADD_FRIEND_DAILY_LIMIT')),
    automationMaxTier: parseAutomationTier(pick('KAKAO_AUTOMATION_MAX_TIER'), agentMode.mode),
    approval: parseApprovalConfig(pick('KAKAO_APPROVAL_LISTEN'), pick('KAKAO_APPROVAL_ORIGIN'), pick('KAKAO_APPROVAL_NOTIFY'),
      pick('KAKAO_APPROVAL_WINDOW_MINUTES'), pick('KAKAO_APPROVAL_WINDOWS'), pick('KAKAO_APPROVAL_CLIENT_CONFIRM')),
    dataDir: resolveDataDir(pick('KAKAO_DATA_DIR'), opts.homedir ?? os.homedir()),
    envPath,
    client: { appVersion, os: clientOs, lang, timeZone },
    tokenRefresh: {
      enabled: TRUTHY.has((pick('KAKAO_ENABLE_TOKEN_REFRESH') ?? '').toLowerCase()),
      renewalEndpoint: pick('KAKAO_RENEWAL_ENDPOINT'),
      maxAttempts: parseAuthReloginAttempts(pick('KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS'))
    },
    recordFile: pick('KAKAO_RECORD_FILE'),
    vaultAutoSave,
    vaultMaxBytes: pick('KAKAO_VAULT_MAX_BYTES') !== undefined && /^\d+$/.test(pick('KAKAO_VAULT_MAX_BYTES')!) ? Number(pick('KAKAO_VAULT_MAX_BYTES')) : undefined,
    vaultMinFreeBytes: pick('KAKAO_VAULT_MIN_FREE_BYTES') !== undefined && /^\d+$/.test(pick('KAKAO_VAULT_MIN_FREE_BYTES')!) ? Number(pick('KAKAO_VAULT_MIN_FREE_BYTES')) : 500 * 1024 * 1024,
    vaultDownloadDelayMs: pick('KAKAO_VAULT_DOWNLOAD_DELAY_MS') !== undefined && /^\d+$/.test(pick('KAKAO_VAULT_DOWNLOAD_DELAY_MS')!) ? Number(pick('KAKAO_VAULT_DOWNLOAD_DELAY_MS')) : 1000
  };
}

/** One-line summary for startup logs (contains no secrets). */
export function describeConfig(c: KakaoConfig): string {
  return (
    `client=${c.client.os}/${c.client.appVersion}/${c.client.lang} ` +
    `agentMode=${c.agentMode}${c.agentModeSource === 'default' ? '(default)' : ''} ` +
    `toolGroups=${c.mcpToolGroups.join(',') || 'none'} tokenRefresh=${c.tokenRefresh.enabled ? 'on' : 'off'}` +
    (c.recordFile ? ' recordFile=enabled' : '') +
    (c.vaultAutoSave ? ' vaultAutoSave=on' : '') +
    (c.approval.origin ? ' approval=enabled' : '')
  );
}

export function parseAuthReloginAttempts(value?: string): number {
  if (value === undefined) return 3;
  if (!/^[1-3]$/.test(value)) throw new KakaoError('CONFIG_INVALID', 'KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS must be 1, 2, or 3');
  return Number(value);
}
