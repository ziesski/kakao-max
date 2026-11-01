import { test as nodeTest } from 'node:test';
// Linux service installer (systemd units, service users); not supported on Windows.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapLocal, serviceUnit, type BootstrapHost } from './setup-system.ts';
import { updateManaged } from './update-managed.ts';
import { readRelease, releaseDigest, installRelease } from './release.ts';

const EMAIL = 'operator@example.test', PASSWORD = 'fixture-password-never-log', TOKEN = 'fixture-token-never-log';

function release(parent: string, name: string, version: string, body: string) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'dist/web-public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kakao-max', version }));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT fixture');
  fs.writeFileSync(path.join(dir, 'dist/mcp.mjs'), body);
  fs.writeFileSync(path.join(dir, 'dist/web-public/index.html'), '<!doctype html>');
  return readRelease(dir);
}

function fixture(t: { after(fn: () => void): void }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'package-install-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'managed'), repo = path.join(parent, 'repo'); fs.mkdirSync(repo);
  const commands: Array<{ program: string; args: string[] }> = [];
  let answers = [EMAIL, PASSWORD, ''], user = false, started = false;
  const uid = process.getuid!() || 65000, gid = process.getgid!();
  const host: BootstrapHost = {
    root, repo, unitFile: path.join(parent, 'daemon.service'), node: '/usr/bin/node', npm: '',
    reason: 'fixture package bootstrap', release: release(parent, 'release-1', '0.1.0', '// daemon 0.1.0\n'),
    log: () => {}, prompt: async q => q.startsWith('자동 재로그인을 위해') || q.startsWith('에이전트 모드') ? '' : answers.shift() ?? '',
    run: (program, args) => {
      commands.push({ program, args });
      if (program === 'getent') return user ? `kakao-max:x:${uid}:${gid}::/var/lib/kakao-max:/usr/sbin/nologin` : '';
      if (program === 'useradd') user = true;
      if (program === 'id') return String(args[0] === '-u' ? uid : gid);
      if (program === 'systemctl' && args[0] === 'enable') started = true;
      if (program === 'systemctl' && args[0] === 'is-active') return started ? 'active' : 'inactive';
      return '';
    },
    register: async (_email, _password, uuid) => ({ status: 0, deviceUuid: uuid, credentials: { userId: '123456789', accessToken: TOKEN } }),
    occupied: async () => false, healthy: async () => started, wait: async () => {}
  };
  return { host, commands, root, parent,
    answers: (a: string[]) => { answers = a; },
    state: () => JSON.parse(fs.readFileSync(path.join(root, 'install-state.json'), 'utf8')) };
}

test('the release digest covers package.json, LICENSE and dist/, and a copy keeps .env.local', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-')); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const r = release(parent, 'r', '1.2.3', 'one');
  assert.equal(r.version, '1.2.3'); assert.match(r.digest, /^[a-f0-9]{64}$/);
  const app = path.join(parent, 'app'); fs.mkdirSync(app); fs.writeFileSync(path.join(app, '.env.local'), 'KAKAO_USER_ID=1\n');
  installRelease(r, app);
  assert.equal(releaseDigest(app), r.digest); assert.equal(fs.readFileSync(path.join(app, '.env.local'), 'utf8'), 'KAKAO_USER_ID=1\n');
  fs.writeFileSync(path.join(app, 'dist/mcp.mjs'), 'changed');
  assert.notEqual(releaseDigest(app), r.digest);
  fs.writeFileSync(path.join(parent, 'r/package.json'), JSON.stringify({ name: 'other', version: '1.2.3' }));
  assert.throws(() => readRelease(path.join(parent, 'r')), { code: 'CONFIG_INVALID' });
  fs.symlinkSync(path.join(parent, 'r/LICENSE'), path.join(parent, 'r/dist/link'));
  assert.throws(() => releaseDigest(path.join(parent, 'r')), { code: 'STORAGE_UNSAFE' });
});

test('a package bootstrap copies and pins the release without Git, npm or a build, and runs the bundled daemon', async t => {
  const f = fixture(t);
  assert.equal(await bootstrapLocal(f.host), 'ready');
  assert.ok(!f.commands.some(c => ['git', 'runuser'].includes(c.program)));
  assert.deepEqual(f.state(), { version: 2, release: '0.1.0', digest: f.host.release!.digest, phase: 'running', port: 8787 });
  const app = path.join(f.root, 'app');
  assert.equal(releaseDigest(app), f.host.release!.digest);
  assert.ok(fs.existsSync(path.join(app, '.env.local')));
  const unit = fs.readFileSync(f.host.unitFile, 'utf8');
  assert.equal(unit, serviceUnit(app, path.join(f.root, 'data'), '/usr/bin/node', 'kakao-max', undefined, 'package'));
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" dist\/mcp\.mjs$/m);
  assert.ok(!unit.includes('--experimental-strip-types'));
  assert.ok(f.commands.some(c => c.program === 'chown' && c.args.includes('root:kakao-max')));
  assert.match(fs.readFileSync(path.join(f.root, 'deploys.log'), 'utf8'), new RegExp(`human 0\\.1\\.0 sha256:${f.host.release!.digest} `));
});

test('a package bootstrap refuses a source install and a tampered copy before any login', async t => {
  const f = fixture(t);
  f.answers([EMAIL, PASSWORD, 'n']); assert.equal(await bootstrapLocal(f.host), 'configured');
  fs.writeFileSync(path.join(f.root, 'app/dist/mcp.mjs'), '// changed after install\n');
  await assert.rejects(bootstrapLocal(f.host), /Installed files differ from the pinned release/);
  assert.ok(!fs.existsSync(f.host.unitFile));

  const source = fixture(t); fs.mkdirSync(source.root);
  fs.writeFileSync(path.join(source.root, 'install-state.json'), JSON.stringify({ version: 1, commit: 'a'.repeat(40), phase: 'running', port: 8787 }), { mode: 0o600 });
  await assert.rejects(bootstrapLocal(source.host), /set up from a source checkout/);
});

test('a prepared package install with no credentials moves to a newer release and keeps its pending device key', async t => {
  const f = fixture(t);
  f.answers([]);
  // Stop before login: an empty email aborts after the release is prepared.
  await assert.rejects(bootstrapLocal(f.host), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.state().phase, 'prepared');
  fs.writeFileSync(path.join(f.root, 'install-state.json'), JSON.stringify({ ...f.state(), deviceUuid: 'A'.repeat(70) + '==' }), { mode: 0o600 });
  const next = release(f.parent, 'release-2', '0.2.0', '// daemon 0.2.0\n');
  f.answers([]);
  await assert.rejects(bootstrapLocal({ ...f.host, release: next }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.state().release, '0.2.0'); assert.equal(f.state().digest, next.digest); assert.equal(f.state().deviceUuid, 'A'.repeat(70) + '==');
  assert.equal(releaseDigest(path.join(f.root, 'app')), next.digest);
});

test('a package update stops the daemon, swaps the release, keeps credentials and records the new pin', async t => {
  const f = fixture(t); await bootstrapLocal(f.host);
  const env = path.join(f.root, 'app/.env.local');
  fs.appendFileSync(env, 'KAKAO_MCP_ALLOWED_UIDS=1000\n');
  const credentials = fs.readFileSync(env, 'utf8');
  const next = release(f.parent, 'release-2', '0.2.0', '// daemon 0.2.0\n');
  const commands: string[] = []; let active = true;
  const update = { root: f.root, repo: f.host.repo, unitFile: f.host.unitFile, node: '/usr/bin/node', npm: '', target: 'release', reason: 'fixture package update', release: next,
    run: (program: string, args: string[]) => {
      commands.push(`${program} ${args.join(' ')}`);
      if (program === 'id') return String(args[0] === '-u' ? (process.getuid!() || 65000) : process.getgid!());
      if (program === 'systemctl' && args[0] === 'is-active') return active ? 'active' : 'inactive';
      if (program === 'systemctl' && args[0] === 'stop') active = false;
      if (program === 'systemctl' && args[0] === 'start') active = true;
      return '';
    }, healthy: async () => active, wait: async () => {} };
  await updateManaged(update);
  assert.ok(!commands.some(c => c.startsWith('git ') || c.startsWith('runuser ')));
  assert.ok(commands.indexOf('systemctl stop kakao-max.service') < commands.indexOf('systemctl start kakao-max.service'));
  assert.equal(fs.readFileSync(env, 'utf8'), credentials);
  assert.equal(releaseDigest(path.join(f.root, 'app')), next.digest);
  assert.deepEqual(f.state(), { version: 2, release: '0.2.0', digest: next.digest, phase: 'running', port: 8787 });

  commands.length = 0; await updateManaged(update);
  assert.ok(!commands.includes('systemctl stop kakao-max.service'), 'the same release does not restart the daemon');
  await assert.rejects(updateManaged({ ...update, release: undefined, target: 'b'.repeat(40) }), /set up from the kakao-max package/);
  fs.writeFileSync(path.join(f.root, 'app/dist/mcp.mjs'), 'tampered');
  await assert.rejects(updateManaged({ ...update, release: f.host.release }), /differ from the recorded release/);
  assert.equal(active, true);
});
