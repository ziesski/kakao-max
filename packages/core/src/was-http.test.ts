import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasRequest } from './was-http.ts';
import { KakaoError } from './errors.ts';

const CLIENT = { appVersion: '26.4.0', os: 'mac' as const, lang: 'ko', timeZone: 'Asia/Seoul' };
const CREDS = { accessToken: 'fake-token', deviceUUID: 'fake-uuid' };
const isCode = (code: string) => (e: unknown) => e instanceof KakaoError && e.code === code;

test('a form makes a urlencoded POST with the Mac client headers', async (t) => {
  let seen: { url: string; init: RequestInit } | undefined;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ status: 0, ok: 1 }), { status: 200 });
  });
  const data = await wasRequest(CLIENT, CREDS, 'friends/add.json', { form: { id: '123 456' } });
  assert.equal(data.ok, 1);
  assert.equal(seen?.url, 'https://katalk.kakao.com/mac/friends/add.json');
  assert.equal(seen?.init.method, 'POST');
  assert.equal(seen?.init.body, 'id=123+456');
  const h = seen?.init.headers as Record<string, string>;
  assert.equal(h['A'], 'mac/26.4.0/ko');
  assert.equal(h['Authorization'], 'fake-token-fake-uuid');
  assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');
});

test('without a form it is a GET with the query encoded', async (t) => {
  let seen: { url: string; init: RequestInit } | undefined;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await wasRequest(CLIENT, CREDS, 'profile3/me.json', { query: { profileId: 'p1', timeZone: 'Asia/Seoul' } });
  assert.equal(seen?.url, 'https://katalk.kakao.com/mac/profile3/me.json?profileId=p1&timeZone=Asia%2FSeoul');
  assert.equal(seen?.init.method, 'GET');
  assert.equal((seen?.init.headers as Record<string, string>)['Content-Type'], undefined);
});

test('errors: 401 → AUTH_EXPIRED, other HTTP → NETWORK, body status → LOCO_STATUS, fetch failure → NETWORK', async (t) => {
  const answers: Array<() => Response> = [
    () => new Response('no', { status: 401 }),
    () => new Response('no', { status: 503 }),
    () => new Response(JSON.stringify({ status: -400 }), { status: 200 }),
    () => {
      throw new TypeError('fetch failed');
    }
  ];
  t.mock.method(globalThis, 'fetch', async () => answers.shift()!());
  await assert.rejects(wasRequest(CLIENT, CREDS, 'x.json'), isCode('AUTH_EXPIRED'));
  await assert.rejects(wasRequest(CLIENT, CREDS, 'x.json'), isCode('NETWORK'));
  await assert.rejects(
    wasRequest(CLIENT, CREDS, 'x.json'),
    (e: unknown) => isCode('LOCO_STATUS')(e) && (e as KakaoError).details?.status === -400
  );
  await assert.rejects(wasRequest(CLIENT, CREDS, 'x.json'), isCode('NETWORK'));
});

test('HTTP parsing and transport failures never expose upstream bodies or credentials', async t => {
  for (const answer of [async () => new Response('fixture-private-json-body', { status: 200 }),
    async () => { throw new TypeError('fixture-private-transport-token'); }]) {
    t.mock.method(globalThis, 'fetch', answer);
    await assert.rejects(wasRequest(CLIENT, CREDS, 'profile3/me.json'), (error: unknown) => {
      assert.ok(error instanceof KakaoError); assert.equal(error.code, 'NETWORK');
      assert.equal(JSON.stringify(error).includes('fixture-private'), false);
      assert.equal(error.details?.command, 'profile3/me.json');
      return true;
    });
  }
});
