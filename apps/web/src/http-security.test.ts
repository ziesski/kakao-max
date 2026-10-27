import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRequestProblem, createLaunchSecret, sessionCookie, sessionCookieName, hasSession, matchesSecret } from './http-security.ts';

const PORT = 8899;
const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: '127.0.0.1:8899', ...headers } });

test('the GUI page itself may read and write', () => {
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'same-origin' }), PORT), undefined);
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899', 'content-type': 'application/json' }), PORT), undefined);
  assert.equal(localRequestProblem({ method: 'POST', headers: { host: 'localhost:8899', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:8899', 'content-type': 'application/json' } }, PORT), undefined);
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'none' }), PORT), undefined, 'address typed by the person');
});

test('a local non-browser client passes the browser checks (the launch session below still applies)', () => {
  assert.equal(localRequestProblem(req('GET', {}), PORT), undefined);
  assert.equal(localRequestProblem(req('POST', { 'content-type': 'application/json' }), PORT), undefined);
});

test('DNS rebinding: a foreign Host is refused even when the browser calls it same-origin', () => {
  assert.equal(localRequestProblem({ method: 'GET', headers: { host: 'attacker.example:8899', 'sec-fetch-site': 'same-origin' } }, PORT), 'host');
  assert.equal(localRequestProblem({ method: 'GET', headers: { host: '127.0.0.1:9999' } }, PORT), 'host');
  assert.equal(localRequestProblem({ method: 'GET', headers: {} }, PORT), 'host');
});

test('another website cannot read, embed or post', () => {
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'cross-site' }), PORT), 'cross-site', 'image/fetch to /api/og or /api/history');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example', 'content-type': 'text/plain' }), PORT), 'cross-site');
  // A browser without Fetch Metadata still sends Origin on a cross-site post.
  assert.equal(localRequestProblem(req('POST', { origin: 'https://attacker.example', 'content-type': 'application/json' }), PORT), 'origin');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }), PORT), 'origin', 'browser write without Origin');
});

test('a same-origin write must be JSON, so a form or text/plain post cannot reach the API', () => {
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899', 'content-type': 'text/plain' }), PORT), 'content-type');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899' }), PORT), 'content-type');
});

test('only a request carrying this launch secret has a session', () => {
  const secret = createLaunchSecret(), other = createLaunchSecret();
  assert.notEqual(secret, other, 'every launch gets a new secret');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const cookie = `${sessionCookieName(PORT)}=${secret}`;
  assert.equal(hasSession({ cookie }, PORT, secret), true);
  assert.equal(hasSession({ cookie: `theme=dark; ${cookie}; x=1` }, PORT, secret), true);
  assert.equal(hasSession({}, PORT, secret), false, 'another OS user\'s curl without the cookie');
  assert.equal(hasSession({ cookie: `${sessionCookieName(PORT)}=${other}` }, PORT, secret), false, 'a previous launch');
  assert.equal(hasSession({ cookie: `${sessionCookieName(9999)}=${secret}` }, PORT, secret), false, 'another port');
  assert.equal(hasSession({ cookie: `${sessionCookieName(PORT)}=${secret.slice(0, -1)}` }, PORT, secret), false);
});

test('the launch cookie is browser-only and never sent cross-site', () => {
  const set = sessionCookie(PORT, 'abc');
  assert.match(set, /^kakao_max_web_8899=abc;/);
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\//);
});

test('launch secret comparison rejects missing, empty and wrong values', () => {
  const secret = createLaunchSecret();
  assert.equal(matchesSecret(secret, secret), true);
  for (const bad of [undefined, null, '', 'x', secret + 'x', 42]) assert.equal(matchesSecret(bad, secret), false);
});
