import { test as nodeTest } from 'node:test';
// Linux service installer (systemd units, service users); not supported on Windows.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapLocal, installPort, serviceUnit, type BootstrapHost } from './setup-system.ts';

const COMMIT = 'a'.repeat(40), EMAIL = 'operator@example.test', PASSWORD = 'fixture-password-never-log', TOKEN = 'fixture-token-never-log';
function fixture(t: { after(fn: () => void): void }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-system-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'managed'), repo = path.join(parent, 'repo'); fs.mkdirSync(repo);
  const commands: Array<{ program: string; args: string[] }> = [], logs: string[] = [],
    registrations: Array<{ email: string; password: string; uuid: string; takeover: boolean }> = [];
  let sourceCommit = COMMIT, installedCommit = COMMIT, rememberLogin = false;
  let answers = [EMAIL, PASSWORD, ''], statuses: number[] = [], user = false, started = false,
    occupied = false, unhealthy = false, failBuild = false, healthDelay = 0, waits = 0, dirty = false;
  const uid = process.getuid!() || 65000, gid = process.getgid!();
  const host: BootstrapHost = {
    root, repo, unitFile: path.join(parent, 'daemon.service'), node: '/usr/bin/node', npm: '/usr/share/npm/bin/npm-cli.js',
    reason: 'fixture self-hosted bootstrap',
    log: s => logs.push(s), prompt: async (_q, secret) => {
      assert.ok(!_q.includes('PREPARE') && !_q.includes('LOGIN'), 'no redundant installation or login confirmation');
      if (_q.startsWith('자동 재로그인을 위해')) return rememberLogin ? 'y' : '';
      const value = answers.shift() ?? '';
      if (value === PASSWORD) assert.equal(secret, true);
      return value;
    },
    run: (program, args) => {
      commands.push({ program, args });
      if (program === 'git') {
        if (args.includes('rev-parse')) return args.includes(path.join(root, 'app')) ? installedCommit : sourceCommit;
        if (args.includes('merge-base')) return installedCommit;
        if (args.includes('checkout')) installedCommit = args[args.length - 1];
        if (args.includes('status')) return dirty ? ' M file.ts' : '';
        if (args.includes('clone')) fs.mkdirSync(path.join(root, 'app'));
      }
      if (program === 'getent') return user ? `kakao-max:x:${uid}:${gid}::/var/lib/kakao-max:/usr/sbin/nologin` : '';
      if (program === 'useradd') user = true;
      if (program === 'id') return String(args[0] === '-u' ? uid : gid);
      if (program === 'runuser' && args.some(v => v.endsWith('/tsc')) && failBuild) { failBuild = false; throw new Error('fixture build failure'); }
      if (program === 'systemctl' && args[0] === 'enable') started = true;
      if (program === 'systemctl' && args[0] === 'is-active') return started ? 'active' : 'inactive';
      return '';
    },
    register: async (email, password, uuid, takeover) => {
      registrations.push({ email, password, uuid, takeover });
      const status = statuses.shift() ?? 0;
      return { status, deviceUuid: uuid, credentials: status === 0 ? { userId: '123456789', accessToken: TOKEN } : undefined };
    },
    occupied: async () => occupied,
    healthy: async expected => { assert.equal(expected, '123456789'); if (healthDelay) { healthDelay--; return false; } return started && !unhealthy; },
    wait: async () => { waits++; }
  };
  return { host, commands, logs, registrations, root, repo, parent,
    advance: () => { sourceCommit = 'b'.repeat(40); },
    rememberLogin: () => { rememberLogin = true; },
    answers: (a: string[]) => { answers = a; }, statuses: (s: number[]) => { statuses = s; },
    busy: () => { occupied = true; }, dirty: () => { dirty = true; }, unhealthy: () => { unhealthy = true; },
    failBuild: () => { failBuild = true; }, healthDelay: () => { healthDelay = 2; }, waits: () => waits,
    state: () => JSON.parse(fs.readFileSync(path.join(root, 'install-state.json'), 'utf8')),
    env: () => fs.readFileSync(path.join(root, 'app/.env.local'), 'utf8') };
}

test('new Linux bootstrap pins Git, isolates code/data, starts only after confirmation and persists no password or implicit room grant', async t => {
  const f = fixture(t); f.healthDelay();
  const oldMask = process.umask(0o077);
  try { await bootstrapLocal(f.host); } finally { process.umask(oldMask); }
  assert.equal(f.registrations.length, 1); assert.equal(f.registrations[0].takeover, false);
  assert.equal(f.state().phase, 'running'); assert.equal(f.state().deviceUuid, undefined);
  assert.ok(!f.env().includes('KAKAO_MCP_PERMISSION_MODEL')); assert.match(f.env(), /KAKAO_ENABLE_TOKEN_REFRESH=0/);
  for (const secret of [PASSWORD, EMAIL]) assert.ok(!f.env().includes(secret));
  assert.ok(!f.env().includes('KAKAO_ALLOWED_CHAT_IDS')); assert.ok(!f.env().includes('KAKAO_NOTIFY_CHAT_ID'));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'data')), []);
  assert.equal(fs.statSync(path.join(f.root, 'app/.env.local')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.root, 'data')).mode & 0o777, 0o700);
  assert.ok(f.commands.some(c => c.program === 'git' && c.args.includes('--no-local')));
  assert.ok(f.commands.some(c => c.program === 'git' && c.args.includes('--detach') && c.args.includes(COMMIT)));
  assert.equal(fs.statSync(f.root).mode & 0o777, 0o755);
  assert.ok(f.commands.some(c => c.program === 'chown' && c.args.includes('root:kakao-max')));
  assert.ok(f.commands.some(c => c.program === 'chmod' && c.args.includes('u=rwX,g=rX,o=')));
  assert.ok(f.commands.some(c => c.program === 'runuser' && c.args.includes('--cache')));
  assert.ok(!fs.existsSync(path.join(f.root, 'build-cache')));
  const trace = JSON.stringify({ commands: f.commands, logs: f.logs });
  for (const secret of [PASSWORD, TOKEN, EMAIL, f.registrations[0].uuid]) assert.ok(!trace.includes(secret));
  assert.equal(f.waits(), 2);
  assert.ok(!fs.existsSync(`${f.root}.install-lock`));
  const before = f.commands.filter(c => c.program === 'systemctl' && c.args[0] === 'enable').length;
  f.answers([]); await bootstrapLocal(f.host);
  assert.equal(f.registrations.length, 1);
  assert.equal(f.commands.filter(c => c.program === 'systemctl' && c.args[0] === 'enable').length, before);
});

test('preserving the other PC on -101 prevents takeover, credentials persistence and service start', async t => {
  const f = fixture(t); f.statuses([-101]); f.answers([EMAIL, PASSWORD, '']);
  await assert.rejects(bootstrapLocal(f.host), { code: 'PC_SESSION_CONFLICT' });
  assert.deepEqual(f.registrations.map(r => r.takeover), [false]); assert.equal(f.state().phase, 'prepared');
  assert.ok(!fs.existsSync(path.join(f.root, 'app/.env.local')));
  assert.ok(!f.commands.some(c => c.program === 'systemctl'));
});

test('only a human yes answer permits one conflict retry with the same device key', async t => {
  const f = fixture(t); f.statuses([-101,0]); f.answers([EMAIL, PASSWORD, 'y','y']);
  await bootstrapLocal(f.host);
  assert.deepEqual(f.registrations.map(r => r.takeover), [false,true]);
  assert.equal(f.registrations[0].uuid, f.registrations[1].uuid);
  const failed = fixture(t); failed.statuses([-101,-101]); failed.answers([EMAIL, PASSWORD, 'y']);
  await assert.rejects(bootstrapLocal(failed.host), { code: 'PC_SESSION_CONFLICT' }); assert.equal(failed.registrations.length, 2);
});

test('phone rejection preserves the pending key for a human retry and never starts the service', async t => {
  const f = fixture(t); f.statuses([-142]); f.answers([EMAIL, PASSWORD]);
  await assert.rejects(bootstrapLocal(f.host), { code: 'APPROVAL_REQUIRED' });
  const uuid = f.state().deviceUuid;
  assert.equal(uuid, f.registrations[0].uuid); assert.ok(!fs.existsSync(path.join(f.root, 'app/.env.local')));
  f.answers([EMAIL, PASSWORD, 'n']); await bootstrapLocal(f.host);
  assert.equal(f.registrations[1].uuid, uuid); assert.equal(f.state().phase, 'configured');
  assert.ok(!f.commands.some(c => c.program === 'systemctl' && c.args[0] === 'enable'));
});

test('cancelled startup resumes configured credentials without registering again, including an interrupted phase update', async t => {
  const f = fixture(t); f.answers([EMAIL, PASSWORD, 'n']); assert.equal(await bootstrapLocal(f.host), 'configured');
  assert.equal(f.state().phase, 'configured'); assert.equal(f.registrations.length, 1);
  fs.writeFileSync(path.join(f.root, 'install-state.json'), JSON.stringify({ version: 1, commit: COMMIT, phase: 'prepared', deviceUuid: f.registrations[0].uuid }), { mode: 0o600 });
  f.answers(['y']); await bootstrapLocal(f.host);
  assert.equal(f.registrations.length, 1); assert.equal(f.state().phase, 'running');
});

test('a build failure can resume the same pinned checkout without re-cloning or creating another service user', async t => {
  const f = fixture(t); f.failBuild(); f.answers([]);
  await assert.rejects(bootstrapLocal(f.host), /fixture build failure/); assert.equal(f.state().phase, 'building');
  assert.equal(f.registrations.length, 0);
  f.answers([EMAIL, PASSWORD, 'y']); await bootstrapLocal(f.host);
  assert.equal(f.commands.filter(c => c.program === 'git' && c.args.includes('clone')).length, 1);
  assert.equal(f.commands.filter(c => c.program === 'useradd').length, 1); assert.equal(f.registrations.length, 1);
});

test('legacy credentials, another service, a busy endpoint, dirty Git and a held lock all refuse before login', async t => {
  for (const kind of ['credentials','unit','unit-link','busy','dirty','lock'] as const) {
    const f = fixture(t);
    if (kind === 'credentials') fs.writeFileSync(path.join(f.repo, '.env.local'), 'KAKAO_ACCESS_TOKEN=fixture\n');
    if (kind === 'unit') fs.writeFileSync(f.host.unitFile, 'fixture legacy service');
    if (kind === 'unit-link') fs.symlinkSync(path.join(f.parent, 'missing-unit'), f.host.unitFile);
    if (kind === 'busy') f.busy();
    if (kind === 'dirty') f.dirty();
    if (kind === 'lock') fs.writeFileSync(`${f.root}.install-lock`, 'fixture lock');
    await assert.rejects(bootstrapLocal(f.host)); assert.equal(f.registrations.length, 0);
    assert.ok(!f.commands.some(c => c.program === 'useradd' || c.program === 'systemctl'));
  }
});

test('malformed registration credentials cannot inject env settings or reach service start', async t => {
  for (const kind of ['token','account','device','status'] as const) {
    const f = fixture(t);
    f.host.register = async (_email, _password, uuid) => ({ status: kind === 'status' ? NaN : 0,
      deviceUuid: kind === 'device' ? Buffer.alloc(52).toString('base64') : uuid,
      credentials: { userId: kind === 'account' ? '9223372036854775808' : '123456789',
        accessToken: kind === 'token' ? 'fixture\nKAKAO_NOTIFY_CHAT_ID=123456789' : TOKEN } });
    await assert.rejects(bootstrapLocal(f.host), { code: kind === 'status' ? 'LOCO_STATUS' : 'CONFIG_INVALID' });
    assert.ok(!fs.existsSync(path.join(f.root, 'app/.env.local')));
    assert.ok(!f.commands.some(c => c.program === 'systemctl'));
  }
});

test('operator pause and a changed service definition are preserved on resume', async t => {
  for (const kind of ['pause','unit'] as const) {
    const f = fixture(t); f.answers([EMAIL, PASSWORD, 'n']); await bootstrapLocal(f.host);
    if (kind === 'pause') fs.writeFileSync(path.join(f.root, 'data/operator-paused'), 'fixture');
    else fs.writeFileSync(f.host.unitFile, 'fixture different service');
    f.answers(['y']); await assert.rejects(bootstrapLocal(f.host), { code: kind === 'pause' ? 'POLICY_DENIED' : 'WORKER_IN_USE' });
    assert.equal(f.registrations.length, 1); assert.ok(!f.commands.some(c => c.program === 'systemctl'));
  }
});

test('unhealthy startup is reported as failure without an automatic login or restart loop', async t => {
  const f = fixture(t); f.unhealthy();
  await assert.rejects(bootstrapLocal(f.host), { code: 'NOT_CONNECTED' });
  assert.equal(f.registrations.length, 1); assert.equal(f.waits(), 9);
  assert.equal(f.commands.filter(c => c.program === 'systemctl' && c.args[0] === 'enable').length, 1);
  assert.ok(!f.commands.some(c => c.args.includes('restart'))); assert.equal(f.state().phase, 'configured');
});

test('systemd paths are quoted with specifier/variable escaping and the service cannot write its code', () => {
  const unit = serviceUnit('/var/lib/fixture app', '/var/lib/fixture data', '/usr/bin/node');
  assert.match(unit, /User=kakao-max/); assert.match(unit, /ProtectSystem=strict/); assert.match(unit, /ProtectHome=true/);
  assert.match(unit, /WorkingDirectory=\/var\/lib\/fixture app\n/);
  assert.match(unit, /ReadWritePaths="\/var\/lib\/fixture data" "\/var\/lib\/fixture app\/\.env.local"/);
  assert.match(serviceUnit('/var/lib/app', '/var/lib/data', '/usr/bin/%node/$name'), /%%node\/\$\$name/);
  assert.throws(() => serviceUnit('/bad\npath','/data','/usr/bin/node'), { code: 'CONFIG_INVALID' });
});


test('alternate loopback install port survives configured resume and rejects endpoint changes before login', async t => {
  const f = fixture(t); f.host.port = 18787; f.host.operatorUid = 1000;
  f.answers([EMAIL, PASSWORD, 'n']);
  assert.equal(await bootstrapLocal(f.host), 'configured');
  assert.match(f.env(), /KAKAO_MCP_LISTEN=127\.0\.0\.1:18787/);
  assert.match(f.env(), /KAKAO_MCP_ALLOWED_UIDS=1000/, 'the installing operator is the OS user the daemon serves');
  assert.equal(f.state().port, 18787);
  f.host.port = 18788;
  await assert.rejects(bootstrapLocal(f.host), { code: 'CONFIG_INVALID' });
  assert.equal(f.registrations.length, 1);
  f.host.port = 18787; f.answers(['y']);
  assert.equal(await bootstrapLocal(f.host), 'ready');
  assert.equal(f.state().port, 18787);
  f.answers([]); assert.equal(await bootstrapLocal(f.host), 'ready');
  assert.equal(f.registrations.length, 1);
  for (const bad of ['0','80','1023','65536','18787x','127.0.0.1:18787','-1','18787\n']) {
    assert.throws(() => installPort(bad), { code: 'CONFIG_INVALID' });
  }
});


test('a failed login can refresh only clean empty prepared code and retains its pending device key', async t => {
  const f = fixture(t); f.statuses([-500]);
  await assert.rejects(bootstrapLocal(f.host), { code: 'LOCO_STATUS' });
  const uuid = f.state().deviceUuid;
  f.advance(); f.answers([EMAIL, PASSWORD, 'y']);
  assert.equal(await bootstrapLocal(f.host), 'ready');
  assert.equal(f.registrations.length, 2);
  assert.equal(f.registrations[1].uuid, uuid);
  assert.equal(f.state().commit, 'b'.repeat(40));
  assert.equal(f.commands.filter(c => c.program === 'git' && c.args.includes('clone')).length, 1);
  for (const kind of ['configured', 'data', 'unit', 'credentials'] as const) {
    const g = fixture(t);
    if (kind === 'configured') { g.answers([EMAIL, PASSWORD, 'n']); await bootstrapLocal(g.host); }
    else {
      g.statuses([-500]); await assert.rejects(bootstrapLocal(g.host));
      if (kind === 'data') fs.writeFileSync(path.join(g.root, 'data/existing'), 'fixture');
      if (kind === 'unit') fs.writeFileSync(g.host.unitFile, 'fixture');
      if (kind === 'credentials') fs.writeFileSync(path.join(g.root, 'app/.env.local'), 'fixture');
    }
    g.advance();
    await assert.rejects(bootstrapLocal(g.host), { code: 'CONFIG_INVALID' });
    assert.equal(g.registrations.length, 1);
  }
});

test('explicit automatic re-login opt-in saves only this installation login data privately', async t => {
  const f = fixture(t); f.rememberLogin(); await bootstrapLocal(f.host);
  assert.ok(f.env().includes(`KAKAO_EMAIL=${EMAIL}`));
  assert.ok(f.env().includes(`KAKAO_PASSWORD=${PASSWORD}`));
  assert.match(f.env(), /KAKAO_ENABLE_TOKEN_REFRESH=1/);
  assert.match(f.env(), /KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS=3/);
  assert.equal(fs.statSync(path.join(f.root, 'app/.env.local')).mode & 0o777, 0o600);
  const trace = JSON.stringify({ commands: f.commands, logs: f.logs });
  for (const secret of [EMAIL, PASSWORD, TOKEN]) assert.ok(!trace.includes(secret));
});
