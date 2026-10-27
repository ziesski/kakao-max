import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KakaoAuthClient } from './auth-client.js';

/** Capture the arguments the client passes to fetch, and return a canned response. */
function stubFetch(status: number, body: Record<string, unknown>) {
  const calls: { url: string; init: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const text = JSON.stringify({ status, ...body });
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('renewToken posts to the renewal endpoint with the token-deviceUuid Authorization header', async () => {
  const stub = stubFetch(0, { access_token: 'NEWTOK', refresh_token: 'NEWREFRESH', token_type: 'bearer' });
  try {
    const client = new KakaoAuthClient('MacBookPro', 'DEVKEY==', { agent: 'mac', version: '26.4.0' });
    const res = await client.renewToken('me@example.com', 'OLDTOK', 'OLDREFRESH');

    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.equal(url, 'https://katalk.kakao.com/mac/account/renewal.json');
    assert.equal(init.method, 'POST');
    // Authorization suffix is literally the device_uuid.
    assert.equal(init.headers.Authorization, 'OLDTOK-DEVKEY==');

    const sent = new URLSearchParams(init.body);
    assert.equal(sent.get('access_token'), 'OLDTOK');
    assert.equal(sent.get('refresh_token'), 'OLDREFRESH');
    assert.equal(sent.get('device_uuid'), 'DEVKEY==');

    assert.equal(res.status, 0);
    assert.equal(res.accessToken, 'NEWTOK');
    assert.equal(res.refreshToken, 'NEWREFRESH');
  } finally {
    stub.restore();
  }
});

test('renewToken honours a custom endpoint override', async () => {
  const stub = stubFetch(0, { access_token: 'X' });
  try {
    const client = new KakaoAuthClient('MacBookPro', 'DEVKEY==');
    await client.renewToken('me@example.com', 'T', 'R', { endpoint: 'renewal/v2.json' });
    assert.equal(stub.calls[0].url, 'https://katalk.kakao.com/mac/account/renewal/v2.json');
  } finally {
    stub.restore();
  }
});

test('renewToken surfaces a failed renewal without throwing', async () => {
  const stub = stubFetch(-100, {});
  try {
    const client = new KakaoAuthClient('MacBookPro', 'DEVKEY==');
    const res = await client.renewToken('me@example.com', 'T', 'R');
    assert.equal(res.status, -100);
    assert.equal(res.accessToken, undefined);
  } finally {
    stub.restore();
  }
});
