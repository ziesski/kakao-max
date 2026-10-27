// ----------------------------------------------------------------------------
// Shared client for KakaoTalk WAS HTTP endpoints (https://katalk.kakao.com/<os>/...).
//
// Every WAS call sends the same Mac client headers and fails the same way:
//   - HTTP 401            → AUTH_EXPIRED
//   - other non-2xx HTTP  → NETWORK
//   - HTTP 200 with a non-zero body `status` → LOCO_STATUS (Kakao often answers errors this way)
//   - fetch / JSON failure → NETWORK
// ----------------------------------------------------------------------------

import type { KakaoConfig } from './config.ts';
import { KakaoError } from './errors.ts';

export interface WasCreds {
  accessToken: string;
  deviceUUID: string;
}

export function wasHeaders(client: KakaoConfig['client'], creds: WasCreds): Record<string, string> {
  return {
    'A': `${client.os}/${client.appVersion}/${client.lang}`,
    'User-Agent': `KT/${client.appVersion} Mc/15.0 ${client.lang}`,
    'Authorization': `${creds.accessToken}-${creds.deviceUUID}`,
    'Accept-Language': client.lang
  };
}

/**
 * Call a WAS endpoint and return its JSON body. `path` is relative to the client OS
 * (e.g. `friends/add.json`) and also names the call in errors. A `form` makes it a
 * urlencoded POST; otherwise it is a GET with `query`.
 */
export async function wasRequest(
  client: KakaoConfig['client'],
  creds: WasCreds,
  path: string,
  opts: { query?: Record<string, string>; form?: Record<string, string>; json?: Record<string, any> } = {}
): Promise<Record<string, any>> {
  const url = new URL(`https://katalk.kakao.com/${client.os}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers = wasHeaders(client, creds);
  let init: RequestInit = { method: 'GET', headers };
  if (opts.json) {
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(opts.json) };
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init = { method: 'POST', headers, body: new URLSearchParams(opts.form).toString() };
  }

  let data: Record<string, any>;
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new KakaoError(res.status === 401 ? 'AUTH_EXPIRED' : 'NETWORK', `Kakao ${path} returned HTTP ${res.status}`, {
        details: { command: path, httpStatus: res.status }
      });
    }
    data = (await res.json()) as Record<string, any>;
  } catch (e) {
    if (e instanceof KakaoError) throw e;
    throw new KakaoError('NETWORK', `Kakao ${path} request failed`, { details: { command: path }, cause: e });
  }
  const status = Number(data?.status ?? 0);
  if (status !== 0) {
    throw new KakaoError('LOCO_STATUS', `Kakao ${path} returned status ${status}`, { details: { command: path, status } });
  }
  return data;
}
