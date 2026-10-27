#!/usr/bin/env node
// ----------------------------------------------------------------------------
// Standalone device-registration bootstrap.
//
// A fresh install can register its own device key. A new device key does NOT
// grant a second active PC session: another PC/Mac client or account daemon can
// cause login.json to return -101 (ANOTHER_LOGON), even after phone approval.
// Reuse the existing runtime or explicitly coordinate an account handover;
// never force-login or stop another owner automatically.
//
// The registration flow itself (login → request_sign → poll confirm_sign on phone
// approval → login) lives in @kakao-max/protocol (KakaoDeviceRegistration,
// verified against a live registration). This module is the thin bootstrap around it: read the
// account email/password from .env.local, run the flow with an on-screen "approve on
// your phone" prompt, then persist the generated device_uuid + fresh tokens back to
// .env.local (preserving every other line) so the next server start reuses them.
//
//   KAKAO_EMAIL       account email               (required; .env.local)
//   KAKAO_PASSWORD    account password            (required; sensitive — .env.local only)
//   KAKAO_DEVICE_NAME device label (default below)
//
// Run:  npm run register --workspace=@kakao-max/mcp
// Safe to re-run; it rewrites only the KAKAO_* keys it owns. Zero runtime deps;
// runs under `node --experimental-strip-types` (no TS parameter properties / enums).
// ----------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { KakaoDeviceRegistration, type SignRegistrationResult } from '@kakao-max/protocol';
import { CredentialStore } from '@kakao-max/core';

/** Default device label shown in the account's 인증 기기 관리 (device management) list. */
export const DEFAULT_DEVICE_NAME = 'KakaoWeb-MCP';

export interface RegistrationPersistInput {
  envPath: string;
  deviceUuid: string;
  credentials?: { userId?: string; accessToken?: string; refreshToken?: string };
  email?: string;
  deviceName?: string;
}

/**
 * Persist a successful registration result to `.env.local`. Pure wrapper over
 * `CredentialStore.persistCredentials` (no network); unit-tested directly. Throws if the
 * result lacks the fields that make the registration usable, so a half-finished run never
 * writes a broken key set.
 */
export function persistRegistration(input: RegistrationPersistInput): void {
  const token = input.credentials?.accessToken;
  if (!input.deviceUuid || !token) {
    throw new Error('registration did not yield a device_uuid + access_token; nothing persisted');
  }
  CredentialStore.persistCredentials(input.envPath, {
    userId: input.credentials?.userId,
    accessToken: token,
    refreshToken: input.credentials?.refreshToken,
    deviceUUID: input.deviceUuid,
    email: input.email,
    deviceName: input.deviceName
  });
}

/** Format the registration outcome for a human running the CLI (never prints tokens). */
export function describeResult(res: SignRegistrationResult): string {
  if (res.status === 0 && res.credentials?.accessToken) {
    return 'registered device; tokens issued';
  }
  return `registration did not complete (status ${Number.isSafeInteger(res.status) ? res.status : 'unknown'})`;
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`[register] ${line}\n`);

  const { email, password, deviceName, envPath } = CredentialStore.readOptional();
  if (!email || !password) {
    log('Missing KAKAO_EMAIL / KAKAO_PASSWORD. Set them in .env.local (password is sensitive —');
    log('.env.local only), then re-run. npm run setup does this for a new Linux install.');
    process.exit(1);
  }
  const name = deviceName || DEFAULT_DEVICE_NAME;

  log('Registering a new device key; phone approval is required. Another active PC session may conflict.');
  const reg = new KakaoDeviceRegistration(name);

  const res = await reg.register(email, password, {
    onAwaitingApproval: (info) => {
      log('──────────────────────────────────────────────────────────────');
      log('Approve this login on your phone now.');
      if (info.expireAfter) log(`The approval window is open for ~${info.expireAfter} min.`);
      log('Open KakaoTalk on your phone and confirm the sign-in prompt…');
      log('──────────────────────────────────────────────────────────────');
    },
    onPoll: (attempt) => log(`waiting for phone approval… (poll ${attempt})`)
  });

  if (res.status !== 0 || !res.credentials?.accessToken) {
    log(describeResult(res));
    process.exit(2);
  }

  persistRegistration({ envPath, deviceUuid: res.deviceUuid, credentials: res.credentials, email, deviceName: name });
  log(describeResult(res));
  log('Saved device credentials. The MCP server can now start.');
  process.exit(0);
}

// Run as a CLI unless imported (e.g. by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write('[register] Registration failed; review the account and phone approval before retrying.\n');
    process.exit(1);
  });
}
