import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthRefresher, type AuthClientLike } from './auth-refresh.ts';
import { AuthReloginBudget } from './auth-relogin-budget.ts';
import type { CredentialStore, KakaoCredentials } from './credentials.ts';

const ctx = { status: -950, accessToken: 'old', deviceUUID: 'dev' };
function fixture(t: { after(fn: () => void): void }, replies: Array<Record<string, any> | Error>, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-relogin-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state: KakaoCredentials = { userId: '1', accessToken: 'old', deviceUUID: 'dev', email: 'operator@example.test', password: 'fixture-secret' };
  const updates: unknown[] = [], calls: unknown[][] = [], waits: number[] = [], logs: string[] = [];
  const file = path.join(dir, 'auth-relogin.json');
  const creds = { get: () => ({ ...state }), update: (p: Partial<KakaoCredentials>) => { updates.push(p); Object.assign(state, p); } } as unknown as CredentialStore;
  const make = () => createAuthRefresher({ config: { tokenRefresh: { enabled } }, creds,
    budget: new AuthReloginBudget(file), wait: async ms => { waits.push(ms); }, log: l => logs.push(l),
    authClient: () => ({ login: async (...args: unknown[]) => {
      calls.push(args); const reply = replies.shift(); if (reply instanceof Error) throw reply;
      return { status: -1, httpStatus: 200, raw: {}, ...reply };
    } }) as unknown as AuthClientLike });
  return { make, state, updates, calls, waits, logs, file, creds };
}
const success = { status: 0, httpStatus: 200, raw: { userId: '1', access_token: 'new', refresh_token: 'refresh' } };

test('disabled refresh and non-auth status never call login', async t => {
  const f = fixture(t, [], false); assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 0);
  const g = fixture(t, [success]); assert.equal(await g.make()({ ...ctx, status: -101 }), null); assert.equal(g.calls.length, 0);
});
test('ordinary login validates account, explicitly forbids takeover, persists tokens and coalesces concurrent refreshes', async t => {
  const f = fixture(t, [success]); const refresh = f.make();
  assert.deepEqual(await Promise.all([refresh(ctx), refresh(ctx)]), [{ accessToken: 'new' }, { accessToken: 'new' }]);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].slice(2), [false, true]);
  assert.deepEqual(f.updates, [{ accessToken: 'new', refreshToken: 'refresh' }]);
  assert.ok(!JSON.stringify(f.logs).includes(f.state.password!));
});
test('missing password never uses a speculative renewal endpoint', async t => {
  const f = fixture(t, [success]); f.state.password = undefined;
  assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 0);
});
test('transport and 5xx failures back off, with at most three calls even after process recreation', async t => {
  const reset = Object.assign(new Error('never log me'), { code: 'ECONNRESET' });
  const f = fixture(t, [reset, { httpStatus: 503, status: 503 }, reset, success]);
  assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.waits, [30000, 60000]);
  assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 3);
});
test('credential rejection, competing PC, challenge, wrong identity and malformed tokens stop without retry or token writes', async t => {
  for (const reply of [{ status: -101 }, { status: -1 }, { status: -142 }, { httpStatus: 429 },
    { ...success, raw: { ...success.raw, userId: '2' } }, { ...success, raw: { ...success.raw, access_token: 'bad\nvalue' } }]) {
    const f = fixture(t, [reply, success]);
    assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 1); assert.deepEqual(f.updates, []);
    assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
  }
});
test('unknown errors and credential persistence errors stop permanently without exposing details', async t => {
  const f = fixture(t, [new Error('fixture-secret'), success]);
  assert.equal(await f.make()(ctx), null); assert.equal(await f.make()(ctx), null); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('fixture-secret'));
  const g = fixture(t, [success]); g.creds.update = () => { throw new Error('fixture-secret'); };
  assert.equal(await g.make()(ctx), null); assert.equal(await g.make()(ctx), null); assert.equal(g.calls.length, 1);
});
test('durable budget survives restarts, allows a fresh window, and fails closed on corruption or symlinks', t => {
  const f = fixture(t, []); let now = 1000;
  const budget = () => new AuthReloginBudget(f.file, 3, () => now);
  assert.equal(budget().reserve(), true); assert.equal(budget().reserve(), true); assert.equal(budget().reserve(), true);
  assert.equal(budget().reserve(), false); now += 86400000; assert.equal(budget().reserve(), true);
  budget().stop(); now += 86400000; assert.equal(budget().reserve(), false);
  fs.writeFileSync(f.file, '{'); assert.throws(() => budget().reserve(), /Invalid re-login budget/);
  if (process.platform !== 'win32') { fs.unlinkSync(f.file); fs.symlinkSync(path.join(path.dirname(f.file), 'target'), f.file);
  assert.throws(() => budget().reserve(), /Invalid re-login budget/); }
});


test('tablet re-login uses persisted identity and configured version, never a Mac request', async t => {
  const f = fixture(t, []); f.state.deviceType = 'tablet'; f.state.deviceUUID = 'a'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /\/android\/account\/login.json$/);
    assert.equal((init.headers as Record<string, string>).A, 'android/26.9.0/ko');
    assert.equal(new URLSearchParams(String(init.body)).get('forced'), 'false');
    assert.equal(new URLSearchParams(String(init.body)).get('device_uuid'), f.state.deviceUUID);
    return new Response(JSON.stringify(success.raw ? { status: 0, ...success.raw } : {}));
  });
  const refresh = createAuthRefresher({ config: { tokenRefresh: { enabled: true }, client: { os: 'android', appVersion: '26.9.0', lang: 'ko', timeZone: 'Asia/Seoul' } },
    creds: f.creds, budget: { reserve: () => true, stop: () => {} }, log: () => {} });
  assert.deepEqual(await refresh({ ...ctx, deviceUUID: f.state.deviceUUID }), { accessToken: 'new' });
  assert.equal(f.state.deviceType, 'tablet');
});
