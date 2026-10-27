// Any website open in the person's browser can reach a loopback server. The API answers only
// the GUI's own page: a foreign Host (DNS rebinding), a cross-site fetch or image, and a write
// without this origin or a JSON body (a CSRF form or text/plain post) are refused.
import type { IncomingHttpHeaders } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type LocalRequestProblem = 'host' | 'cross-site' | 'origin' | 'content-type';

export function localRequestProblem(req: { method?: string; headers: IncomingHttpHeaders }, port: number): LocalRequestProblem | undefined {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!own.includes(String(req.headers.host ?? '').toLowerCase())) return 'host';
  // Browsers label every request; 'none' is the person typing the address. Non-browser local clients send neither header.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross-site';
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const origin = req.headers.origin;
  if ((origin !== undefined || site !== undefined) && !own.some(h => origin === `http://${h}`)) return 'origin';
  // A cross-origin JSON post needs a CORS preflight, which this server never grants.
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return 'content-type';
  return undefined;
}

// Loopback keeps the network out, but not other OS users on the same machine: a local client sends
// no browser headers, so the checks above let it through and this server would act as the person.
// Each launch makes a secret that only the person's terminal shows. Opening the printed launch link
// stores it in an HttpOnly, SameSite=Strict cookie; every other request without it is refused.

/** A fresh per-launch secret (256 bits, base64url). */
export function createLaunchSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Cookie name; includes the port so two GUIs on different ports keep separate sessions. */
export function sessionCookieName(port: number): string {
  return `kakao_max_web_${port}`;
}

/** Set-Cookie value for the launch secret. Browser-only, never sent cross-site. */
export function sessionCookie(port: number, secret: string): string {
  return `${sessionCookieName(port)}=${secret}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Constant-time comparison of a presented value with the launch secret. */
export function matchesSecret(presented: unknown, secret: string): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request carries this launch's session cookie. */
export function hasSession(headers: IncomingHttpHeaders, port: number, secret: string): boolean {
  const name = sessionCookieName(port);
  for (const part of String(headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name && matchesSecret(part.slice(eq + 1).trim(), secret)) return true;
  }
  return false;
}
