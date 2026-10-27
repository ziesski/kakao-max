// Ordinary login only: no takeover, registration, or speculative renewal endpoint.
import { KakaoAuthClient, type RefreshedCredentials } from '@kakao-max/protocol';
import type { CredentialStore } from './credentials.ts';
import type { KakaoConfig } from './config.ts';
import type { AuthReloginBudget } from './auth-relogin-budget.ts';

export interface AuthClientLike { login: KakaoAuthClient['login'] }
export interface AuthFailure { status: number; accessToken: string; deviceUUID: string }

export function createAuthRefresher(deps: {
  config: Pick<KakaoConfig, 'tokenRefresh'>;
  creds: CredentialStore;
  budget: Pick<AuthReloginBudget, 'reserve' | 'stop'>;
  log: (line: string) => void;
  authClient?: (deviceName: string, deviceUUID: string) => AuthClientLike;
  wait?: (ms: number) => Promise<void>;
}): (ctx: AuthFailure) => Promise<RefreshedCredentials | null> {
  const makeClient = deps.authClient ?? ((name, uuid) => new KakaoAuthClient(name, uuid));
  const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let pending: Promise<RefreshedCredentials | null> | undefined;
  const run = async (ctx: AuthFailure): Promise<RefreshedCredentials | null> => {
    // Other LOCO errors (including competing PC sessions) never trigger login.
    if (!deps.config.tokenRefresh.enabled || ctx.status !== -950) return null;
    const c = deps.creds.get();
    if (!c.email || !c.password || c.deviceUUID !== ctx.deviceUUID) {
      deps.log('automatic re-login unavailable: matching device and saved email/password required');
      return null;
    }
    const auth = makeClient(c.deviceName ?? 'KakaoWeb', c.deviceUUID);
    const max = deps.config.tokenRefresh.maxAttempts ?? 3;
    for (let attempt = 0; attempt < max; attempt++) {
      if (attempt) await wait(attempt * 30000);
      if (!deps.budget.reserve()) { deps.log('automatic re-login stopped: durable attempt limit or operator review'); return null; }
      let response: Awaited<ReturnType<AuthClientLike['login']>>;
      try { response = await auth.login(c.email, c.password, false, true); }
      catch (error) {
        // Retry only recognized transport failures. Never log raw errors or bodies.
        const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
        if ((error as Error).name !== 'TimeoutError' && !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code ?? '')) {
          deps.budget.stop(); deps.log('automatic re-login stopped: unexpected request failure'); return null;
        }
        deps.log('automatic re-login transport failure; retry remains bounded');
        continue;
      }
      if (response.httpStatus >= 500 && response.httpStatus <= 599 && response.status >= 0) {
        deps.log('automatic re-login server temporarily unavailable; retry remains bounded');
        continue;
      }
      const token = response.raw?.access_token;
      const refresh = response.raw?.refresh_token;
      if (response.httpStatus !== 200 || response.status !== 0 || String(response.raw?.userId) !== c.userId ||
        typeof token !== 'string' || !token || /[\x00-\x1f\x7f]/.test(token) ||
        (refresh !== undefined && (typeof refresh !== 'string' || /[\x00-\x1f\x7f]/.test(refresh)))) {
        deps.budget.stop();
        deps.log(`automatic re-login stopped: rejected or invalid response (status ${Number.isSafeInteger(response.status) ? response.status : 'unknown'})`);
        return null;
      }
      try {
        deps.creds.update({ accessToken: token, refreshToken: typeof refresh === 'string' ? refresh : c.refreshToken });
      } catch { deps.budget.stop(); deps.log('automatic re-login stopped: credential persistence failed'); return null; }
      deps.log('ordinary re-login succeeded; same account and registered device retained');
      return { accessToken: token };
    }
    deps.log('automatic re-login stopped: attempt limit reached');
    return null;
  };
  return ctx => {
    if (!pending) pending = run(ctx).finally(() => { pending = undefined; });
    return pending;
  };
}
