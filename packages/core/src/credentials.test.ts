import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from './credentials.ts';

function tmpEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkt-creds-'));
  const p = path.join(dir, '.env.local');
  fs.writeFileSync(p, contents);
  return p;
}

test('load reads required KAKAO_* keys from the given .env.local', () => {
  const p = tmpEnv(
    '# comment\nKAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=tok\nKAKAO_REGISTERED_DEVICE_UUID=dev==\nKAKAO_REFRESH_TOKEN=ref\nKAKAO_EMAIL=me@example.com\n'
  );
  const store = CredentialStore.load({ envPath: p, env: {} });
  const c = store.get();
  assert.equal(c.userId, '123');
  assert.equal(c.accessToken, 'tok');
  assert.equal(c.deviceUUID, 'dev==');
  assert.equal(c.refreshToken, 'ref');
  assert.equal(c.email, 'me@example.com');
});

test('load throws a helpful error when required keys are missing', () => {
  const p = tmpEnv('KAKAO_USER_ID=123\n');
  assert.throws(() => CredentialStore.load({ envPath: p, env: {} }), /Missing KAKAO_/);
});

test('update rewrites only the token keys and preserves other lines + comments', () => {
  const p = tmpEnv(
    '# header\nKAKAO_EMAIL=me@example.com\nKAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=old\nKAKAO_REGISTERED_DEVICE_UUID=dev==\nKAKAO_REFRESH_TOKEN=oldref\nOTHER=keepme\n'
  );
  const store = CredentialStore.load({ envPath: p, env: {} });
  store.update({ accessToken: 'NEW', refreshToken: 'NEWREF' });

  const after = fs.readFileSync(p, 'utf-8');
  assert.match(after, /^# header$/m);
  assert.match(after, /^KAKAO_ACCESS_TOKEN=NEW$/m);
  assert.match(after, /^KAKAO_REFRESH_TOKEN=NEWREF$/m);
  assert.match(after, /^KAKAO_EMAIL=me@example\.com$/m);
  assert.match(after, /^OTHER=keepme$/m);
  // device uuid unchanged
  assert.match(after, /^KAKAO_REGISTERED_DEVICE_UUID=dev==$/m);
  // no duplicate access-token lines
  assert.equal((after.match(/^KAKAO_ACCESS_TOKEN=/gm) || []).length, 1);

  // in-memory reflects the update
  assert.equal(store.get().accessToken, 'NEW');
  assert.equal(store.get().refreshToken, 'NEWREF');
});

test('persistence ends with exactly one trailing newline, stable across repeated writes', () => {
  const p = tmpEnv('KAKAO_USER_ID=1\nKAKAO_ACCESS_TOKEN=a\nKAKAO_REGISTERED_DEVICE_UUID=d\n');
  const store = CredentialStore.load({ envPath: p, env: {} });
  store.update({ accessToken: 'b' });
  const first = fs.readFileSync(p, 'utf-8');
  assert.ok(first.endsWith('\n') && !first.endsWith('\n\n'), 'exactly one trailing newline');
  store.update({ accessToken: 'c' });
  const second = fs.readFileSync(p, 'utf-8');
  // no blank-line accumulation on re-write
  assert.ok(!second.includes('\n\n'), 'no accumulated blank lines');
  // a naive append lands on its own line, not glued to the last key=
  CredentialStore.persistCredentials(p, { deviceUUID: 'DEV==' });
  const third = fs.readFileSync(p, 'utf-8');
  assert.match(third, /^KAKAO_REGISTERED_DEVICE_UUID=DEV==$/m);
  assert.ok(third.endsWith('\n'));
});

test('failed credential persistence throws and leaves in-memory tokens unchanged', () => {
  const p = tmpEnv('KAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=old\nKAKAO_REGISTERED_DEVICE_UUID=dev\n');
  const store = CredentialStore.load({ envPath: p, env: {} });
  fs.unlinkSync(p); fs.mkdirSync(p);
  assert.throws(() => store.update({ accessToken: 'new' }), /Cannot read existing credential file/);
  assert.equal(store.get().accessToken, 'old');
  fs.rmdirSync(p);
});

test('human login configuration deduplicates managed keys while preserving device and lower limits', () => {
  const p = tmpEnv('KAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=token\nKAKAO_REGISTERED_DEVICE_UUID=device\nKAKAO_ENABLE_TOKEN_REFRESH=0\nKAKAO_ENABLE_TOKEN_REFRESH=0\n');
  CredentialStore.saveLogin(p, 'operator@example.test', 'fixture-password', 1);
  const saved = fs.readFileSync(p, 'utf8');
  assert.equal(saved.match(/KAKAO_ENABLE_TOKEN_REFRESH=/g)?.length, 1);
  assert.match(saved, /KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS=1/);
  assert.match(saved, /KAKAO_REGISTERED_DEVICE_UUID=device/);
});
