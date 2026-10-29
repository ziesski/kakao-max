import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KakaoAuthClient, calculateXVC, DEFAULT_AUTH_CONFIG } from './auth-client.js';

test('calculateXVC generates 16-character hex digest', () => {
  const xvc = calculateXVC('00000000-0000-0000-0000-000000000001', 'KT/26.4.0 Wd/15.3 ko', 'test@example.com');
  assert.equal(typeof xvc, 'string');
  assert.equal(xvc.length, 16);
  assert.match(xvc, /^[0-9a-f]{16}$/);
});

test('KakaoAuthClient formats correct User-Agent (Mac = Mc token)', () => {
  const client = new KakaoAuthClient('Web Client', 'uuid-123', {
    agent: 'mac',
    version: '26.4.0',
    osVersion: '26.3.1',
    language: 'ko'
  });
  assert.equal(client.userAgent, 'KT/26.4.0 Mc/26.3.1 ko');
});

test('authorization header is accessToken-deviceUuid', () => {
  assert.equal(KakaoAuthClient.authorization('TOKEN123', 'DEVUUID=='), 'TOKEN123-DEVUUID==');
});


test('tablet authentication uses Android headers, X-VC, model and API level consistently', async t => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ status: 0 }));
  });
  const client = new KakaoAuthClient('SM-T870', 'a'.repeat(64), { agent: 'android' });
  await client.login('fixture@example.test', 'fixture-password');
  await client.generatePasscode('fixture@example.test', 'fixture-password');
  await client.registerDevice('fixture@example.test', 'fixture-password');
  assert.equal(client.userAgent, 'KT/25.9.2 An/13 ko');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.A, 'android/25.9.2/ko');
  assert.equal(headers['X-VC'], 'c4f8485f9a8e5b52');
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get('model_name'), 'SM-T870');
  assert.equal(form.get('permanent'), 'true');
  assert.equal(form.get('forced'), 'false');
  assert.equal(form.has('os_version'), false);
  for (const c of calls) { assert.match(c.url, /\/android\/account\//); assert.ok(c.init.signal); }
  const generated = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(generated.device, { name: 'SM-T870', uuid: 'a'.repeat(64), osVersion: '33', model: 'SM-T870' });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), generated);
});

test('tablet OAuth refresh uses the Android JSON request and preserves its device authorization', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /\/android\/account\/oauth2_token.json$/);
    const h = init.headers as Record<string, string>;
    assert.equal(h.Authorization, `old-${'a'.repeat(64)}`);
    assert.equal(h['Content-Type'], 'application/json; charset=utf-8');
    assert.match(h.C, /^[a-f0-9-]{36}$/);
    assert.deepEqual(JSON.parse(String(init.body)), { grant_type: 'refresh_token', access_token: 'old', refresh_token: 'refresh' });
    return new Response(JSON.stringify({ status: 0, access_token: 'new', refresh_token: 'next' }));
  });
  const result = await new KakaoAuthClient('SM-T870', 'a'.repeat(64), { agent: 'android' }).refreshToken('old', 'refresh');
  assert.equal(result.data?.accessToken, 'new');
});
