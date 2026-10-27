import { test as nodeTest } from 'node:test';
// Linux service installer (systemd units, service users); not supported on Windows.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureManagedLogin } from './managed-login.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-login-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local'), budget = path.join(root, 'auth-relogin.json');
  fs.writeFileSync(file, 'KAKAO_USER_ID=123456789\nKAKAO_ACCESS_TOKEN=fixture-token\nKAKAO_REGISTERED_DEVICE_UUID=fixture-device\nKAKAO_ENABLE_TOKEN_REFRESH=0\nKAKAO_AUTH_RELOGIN_MAX_ATTEMPTS=1\n', { mode: 0o600 });
  return { root, file, budget };
}
test('repair saves privately without replacing account/device or increasing a lower attempt limit', async t => {
  const f = fixture(t), answers = ['operator@example.test', 'fixture-password', 'y']; let hidden = false;
  await configureManagedLogin(f.file, f.root, process.getuid!(), async (_q, secret) => { if (secret) hidden = true; return answers.shift()!; });
  const data = fs.readFileSync(f.file, 'utf8'); assert.ok(hidden);
  assert.match(data, /KAKAO_REGISTERED_DEVICE_UUID=fixture-device/); assert.match(data, /KAKAO_USER_ID=123456789/);
  assert.match(data, /KAKAO_ENABLE_TOKEN_REFRESH=1/); assert.match(data, /KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS=1/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});
test('cancelled repair preserves credentials, and durable stops are never silently reset', async t => {
  const f = fixture(t), before = fs.readFileSync(f.file, 'utf8'), answers = ['operator@example.test', 'fixture-password', 'n'];
  await assert.rejects(configureManagedLogin(f.file, f.root, process.getuid!(), async () => answers.shift()!), { code: 'POLICY_DENIED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.appendFileSync(f.file, 'KAKAO_EMAIL=operator@example.test\nKAKAO_PASSWORD=fixture-password\n');
  fs.writeFileSync(f.budget, JSON.stringify({ version: 1, since: Date.now(), attempts: 1, stopped: true }), { mode: 0o600 });
  await assert.rejects(configureManagedLogin(f.file, f.root, process.getuid!(), async () => ''), { code: 'AUTH_EXPIRED' });
  assert.ok(fs.existsSync(f.budget));
});

test('interactive repair replaces invalid UTF-8 only in login fields without a temporary credential copy', async t => {
  const f = fixture(t); fs.appendFileSync(f.file, Buffer.concat([Buffer.from('KAKAO_EMAIL='), Buffer.from([0xff]), Buffer.from('\nKAKAO_PASSWORD='), Buffer.from([0xfe]), Buffer.from('\n')]));
  const answers = ['operator@example.test', 'fixture-password', 'y'];
  await configureManagedLogin(f.file, f.root, process.getuid!(), async () => answers.shift()!);
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(f.file)));
  assert.match(fs.readFileSync(f.file, 'utf8'), /KAKAO_REGISTERED_DEVICE_UUID=fixture-device/);
  assert.deepEqual(fs.readdirSync(f.root), ['.env.local']);
});

test('invalid UTF-8 in a registered key is never repaired or overwritten', async t => {
  const f = fixture(t); fs.appendFileSync(f.file, Buffer.concat([Buffer.from('KAKAO_REGISTERED_DEVICE_UUID='), Buffer.from([0xff]), Buffer.from('\n')]));
  const before = fs.readFileSync(f.file);
  await assert.rejects(configureManagedLogin(f.file, f.root, process.getuid!(), async () => { throw new Error('must not prompt'); }), { code: 'CONFIG_INVALID' });
  assert.deepEqual(fs.readFileSync(f.file), before);
});
