// ----------------------------------------------------------------------------
// Credential refresh strategies for an expired access_token.
//
// Primary: RE-LOGIN via login.json. Posting login.json with the already-registered
// device key returns a fresh access_token/refresh_token (status 0). This is simpler and
// more reliable than the (still-unverified) renewal endpoint. It requires the account password.
//
// Caveat: KakaoTalk enforces one active Mac session per device key, so a re-login
// evicts any other Mac session sharing that key. Give the headless client its OWN
// registered key (device-registration) to avoid fighting the real app.
// ----------------------------------------------------------------------------

/** Minimal shape of an auth response we care about (KakaoAuthClient.login's AuthResult). */
export interface AuthResponseLike {
  status: number;
  raw: Record<string, any>;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Obtain fresh tokens by re-logging in. `login` is injected (the real
 * `KakaoAuthClient.login` bound to the registered device key, or a fake in tests).
 * Returns null when no password is available or the login did not succeed.
 */
export async function refreshViaReLogin(
  creds: { email?: string; password?: string },
  login: (email: string, password: string) => Promise<AuthResponseLike>
): Promise<RefreshedTokens | null> {
  if (!creds.email || !creds.password) return null;
  const res = await login(creds.email, creds.password);
  const token = res.raw?.access_token;
  if (res.status === 0 && typeof token === 'string' && token.length > 0) {
    const refresh = res.raw?.refresh_token;
    return { accessToken: token, refreshToken: typeof refresh === 'string' ? refresh : undefined };
  }
  return null;
}
