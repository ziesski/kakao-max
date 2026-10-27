import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateDeviceUuid } from '@kakao-max/protocol';
import { persistRegistration, describeResult, DEFAULT_DEVICE_NAME } from './register.ts';

function tmpEnv(contents = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkt-register-'));
  const p = path.join(dir, '.env.local');
  if (contents) fs.writeFileSync(p, contents);
  return p;
}

test('generateDeviceUuid yields a 52-byte standard-base64 device_uuid (live format)', () => {
  const u = generateDeviceUuid();
  assert.match(u, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(u, 'base64').length, 52);
  assert.notEqual(generateDeviceUuid(), generateDeviceUuid());
});

test('persistRegistration writes device_uuid + tokens to a fresh .env.local', () => {
  const p = tmpEnv(); // no file yet — brand-new install
  const deviceUuid = generateDeviceUuid();
  persistRegistration({
    envPath: p,
    deviceUuid,
    credentials: { userId: '42', accessToken: 'TOK', refreshToken: 'REF' },
    email: 'me@example.com',
    deviceName: DEFAULT_DEVICE_NAME
  });

  const after = fs.readFileSync(p, 'utf-8');
  assert.match(after, new RegExp(`^KAKAO_REGISTERED_DEVICE_UUID=${deviceUuid.replace(/[+/]/g, '\\$&')}$`, 'm'));
  assert.match(after, /^KAKAO_ACCESS_TOKEN=TOK$/m);
  assert.match(after, /^KAKAO_REFRESH_TOKEN=REF$/m);
  assert.match(after, /^KAKAO_USER_ID=42$/m);
  assert.match(after, /^KAKAO_EMAIL=me@example\.com$/m);
  assert.match(after, /^KAKAO_DEVICE_NAME=KakaoWeb-MCP$/m);
  // the password is never written by the bootstrap
  assert.equal(/^KAKAO_PASSWORD=/m.test(after), false);
  // file is owner-only
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('persistRegistration preserves existing lines/comments and rewrites only its keys', () => {
  const p = tmpEnv(
    '# creds\nKAKAO_EMAIL=me@example.com\nKAKAO_PASSWORD=secret\nKAKAO_ACCESS_TOKEN=OLD\nOTHER=keepme\n'
  );
  persistRegistration({
    envPath: p,
    deviceUuid: 'DEV==',
    credentials: { userId: '7', accessToken: 'NEW' },
    email: 'me@example.com',
    deviceName: 'KakaoWeb-MCP'
  });

  const after = fs.readFileSync(p, 'utf-8');
  assert.match(after, /^# creds$/m);
  assert.match(after, /^KAKAO_PASSWORD=secret$/m); // preserved, not overwritten
  assert.match(after, /^OTHER=keepme$/m);
  assert.match(after, /^KAKAO_ACCESS_TOKEN=NEW$/m);
  assert.match(after, /^KAKAO_REGISTERED_DEVICE_UUID=DEV==$/m);
  // no duplicate access-token line
  assert.equal((after.match(/^KAKAO_ACCESS_TOKEN=/gm) || []).length, 1);
});

test('persistRegistration refuses to write a half-finished registration', () => {
  const p = tmpEnv();
  assert.throws(
    () => persistRegistration({ envPath: p, deviceUuid: 'DEV==', credentials: { userId: '1' } }),
    /device_uuid \+ access_token/
  );
  assert.throws(
    () => persistRegistration({ envPath: p, deviceUuid: '', credentials: { accessToken: 'TOK' } }),
    /device_uuid \+ access_token/
  );
  assert.equal(fs.existsSync(p), false); // nothing written
});

test('describeResult omits account IDs, device keys, tokens and upstream messages', () => {
  const uuid = generateDeviceUuid();
  const ok = describeResult({
    status: 0,
    deviceUuid: uuid,
    credentials: { userId: '42', accessToken: 'SUPER_SECRET_TOKEN' }
  });
  assert.match(ok, /registered device/);
  assert.equal(ok.includes('42'), false);
  assert.equal(ok.includes(uuid.slice(0, 8)), false);
  assert.equal(ok.includes('SUPER_SECRET_TOKEN'), false);

  const fail = describeResult({ status: -142, deviceUuid: uuid, message: 'fixture-private-upstream-body' });
  assert.match(fail, /did not complete/);
  assert.match(fail, /status -142/);
  assert.equal(fail.includes('fixture-private'), false);
});
