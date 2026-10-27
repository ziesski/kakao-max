import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshViaReLogin } from './refresh.ts';

test('refreshViaReLogin returns fresh tokens on a successful login', async () => {
  let called: { email: string; password: string } | null = null;
  const out = await refreshViaReLogin({ email: 'me@example.com', password: 'pw' }, async (email, password) => {
    called = { email, password };
    return { status: 0, raw: { access_token: 'NEWTOK', refresh_token: 'NEWREF', token_type: 'bearer' } };
  });
  assert.deepEqual(called, { email: 'me@example.com', password: 'pw' });
  assert.deepEqual(out, { accessToken: 'NEWTOK', refreshToken: 'NEWREF' });
});

test('refreshViaReLogin returns null without a password (no login attempted)', async () => {
  let attempted = false;
  const out = await refreshViaReLogin({ email: 'me@example.com' }, async () => {
    attempted = true;
    return { status: 0, raw: { access_token: 'X' } };
  });
  assert.equal(attempted, false);
  assert.equal(out, null);
});

test('refreshViaReLogin returns null when login fails or returns no token', async () => {
  const failStatus = await refreshViaReLogin({ email: 'me@example.com', password: 'pw' }, async () => ({
    status: -100,
    raw: { access_token: 'SHOULD_IGNORE' }
  }));
  assert.equal(failStatus, null);

  const noToken = await refreshViaReLogin({ email: 'me@example.com', password: 'pw' }, async () => ({
    status: 0,
    raw: {}
  }));
  assert.equal(noToken, null);
});

test('refreshViaReLogin omits refreshToken when the response lacks one', async () => {
  const out = await refreshViaReLogin({ email: 'me@example.com', password: 'pw' }, async () => ({
    status: 0,
    raw: { access_token: 'TOK' }
  }));
  assert.deepEqual(out, { accessToken: 'TOK', refreshToken: undefined });
});
