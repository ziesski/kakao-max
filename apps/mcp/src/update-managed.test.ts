import { test as nodeTest } from 'node:test';
// Linux service installer (systemd units, service users); not supported on Windows.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceUnit, legacyServiceUnit } from './setup-system.ts';
import { updateManaged } from './update-managed.ts';

function fixture(t: { after(fn: () => void): void }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-update-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'managed'), repo = path.join(parent, 'source'), app = path.join(root, 'app'), data = path.join(root, 'data');
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(data); fs.mkdirSync(repo);
  const uid = process.getuid!() || 65000, gid = process.getgid!(), old = 'a'.repeat(40), target = 'b'.repeat(40);
  const env = path.join(app, '.env.local'), unitFile = path.join(parent, 'daemon.service');
  const credentials = `KAKAO_USER_ID=123456789\nKAKAO_ACCESS_TOKEN=fixture-token\nKAKAO_DATA_DIR=${data}\nKAKAO_MCP_LISTEN=127.0.0.1:18787\nKAKAO_MCP_ALLOWED_UIDS=1000\n`;
  fs.writeFileSync(env, credentials, { mode: 0o600 }); fs.chownSync(env, uid, gid); fs.chownSync(data, uid, gid);
  fs.writeFileSync(path.join(data, 'journal-marker'), 'fixture journal');
  const stateFile = path.join(root, 'install-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, phase: 'running', commit: old, port: 18787 }), { mode: 0o600 });
  fs.writeFileSync(unitFile, serviceUnit(app, data, '/usr/bin/node'));
  const commands: string[] = []; let installed = old, active = true, dirty = false, healthy = true, failBuild = false, portBusy = false, stoppedFailed = false;
  const host = { root, repo, unitFile, node: '/usr/bin/node', npm: '/usr/bin/npm', target, reason: 'fixture update', recover: false,
    run: (program: string, args: string[]) => {
      commands.push(`${program} ${args.join(' ')}`);
      if (program === 'ss') return portBusy ? 'LISTEN fixture' : '';
      if (program === 'id') return String(args[0] === '-u' ? uid : gid);
      if (program === 'git') {
        if (args.includes('rev-parse')) return args.includes(app) ? installed : target;
        if (args.includes('status')) return dirty ? ' M fixture' : '';
        if (args.includes('merge-base')) return old;
        if (args.includes('checkout')) installed = target;
      }
      if (program === 'systemctl') {
        if (args[0] === 'is-active') return active ? 'active' : stoppedFailed ? 'failed' : 'inactive';
        if (args[0] === 'stop') active = false;
        if (args[0] === 'start') active = true;
      }
      if (program === 'runuser' && failBuild) throw new Error('fixture build failure');
      return '';
    }, healthy: async (expected: string) => { assert.equal(expected, '123456789'); return healthy; }, wait: async () => {} };
  return { host, commands, credentials, env, data, stateFile, unitFile,
    failedState: () => { stoppedFailed = true; },
    stoppedConfigured: () => { active = false; fs.writeFileSync(stateFile, JSON.stringify({ version: 1, phase: 'configured', commit: old, port: 18787 })); },
    busyPort: () => { portBusy = true; },
    dirty: () => { dirty = true; }, unhealthy: () => { healthy = false; }, failBuild: () => { failBuild = true; } };
}
test('managed update stops the old daemon before rebuilding, preserves credentials/journal and verifies the same account', async t => {
  const f = fixture(t); await updateManaged(f.host);
  const stop = f.commands.findIndex(c => c === 'systemctl stop kakao-max.service');
  const build = f.commands.findIndex(c => c.startsWith('runuser '));
  const start = f.commands.findIndex(c => c === 'systemctl start kakao-max.service');
  assert.ok(stop >= 0 && build > stop && start > build);
  assert.equal(fs.readFileSync(f.env, 'utf8'), f.credentials);
  assert.equal(fs.statSync(f.env).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.data, 'journal-marker'), 'utf8'), 'fixture journal');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')), { version: 1, phase: 'running', commit: f.host.target, port: 18787 });
  assert.equal(fs.existsSync(`${f.host.root}.install-lock`), false);
});
test('pause, dirty code, changed unit and unhealthy account refuse before stopping the daemon', async t => {
  for (const kind of ['pause', 'dirty', 'unit', 'health']) {
    const f = fixture(t);
    if (kind === 'pause') fs.writeFileSync(path.join(f.data, 'operator-paused'), 'fixture');
    if (kind === 'dirty') f.dirty();
    if (kind === 'unit') fs.appendFileSync(f.unitFile, '\n# fixture change');
    if (kind === 'health') f.unhealthy();
    await assert.rejects(updateManaged(f.host));
    assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')));
    assert.equal(fs.readFileSync(f.env, 'utf8'), f.credentials);
  }
});
test('removed settings refuse before stopping the daemon and name the keys to delete', async t => {
  const f = fixture(t);
  fs.appendFileSync(f.env, 'KAKAO_MCP_PROFILE=full\nKAKAO_MCP_PERMISSION_MODEL=room\n');
  await assert.rejects(updateManaged(f.host), (e: Error) => /KAKAO_MCP_PERMISSION_MODEL, KAKAO_MCP_PROFILE/.test(e.message) && !e.message.includes('full'));
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')));
});
test('an install without KAKAO_MCP_ALLOWED_UIDS refuses before stopping, since the new daemon would refuse the operator tunnel', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.env, f.credentials.replace('KAKAO_MCP_ALLOWED_UIDS=1000\n', ''));
  await assert.rejects(updateManaged(f.host), (e: Error) => /KAKAO_MCP_ALLOWED_UIDS/.test(e.message));
  fs.writeFileSync(f.env, f.credentials.replace('=1000', '=operator'));
  await assert.rejects(updateManaged(f.host), { code: 'CONFIG_INVALID' });
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')));
});
test('a build failure leaves the daemon stopped and credentials protected without a registration or restart retry', async t => {
  const f = fixture(t); f.failBuild();
  await assert.rejects(updateManaged(f.host), /fixture build failure/);
  assert.ok(f.commands.includes('systemctl stop kakao-max.service'));
  assert.ok(!f.commands.includes('systemctl start kakao-max.service'));
  assert.equal(fs.readFileSync(f.env, 'utf8'), f.credentials);
  assert.equal(fs.statSync(f.env).mode & 0o777, 0o600);
});

test('explicit recovery deploys a stopped configured installation before starting the same account', async t => {
  const f = fixture(t); f.stoppedConfigured(); f.failedState(); f.host.recover = true;
  fs.appendFileSync(f.env, 'KAKAO_EMAIL=operator@example.test\nKAKAO_PASSWORD=fixture-password\nKAKAO_ENABLE_TOKEN_REFRESH=1\nKAKAO_AUTH_RELOGIN_MAX_ATTEMPTS=3\n');
  const before = fs.readFileSync(f.env, 'utf8');
  await updateManaged(f.host);
  assert.equal(fs.readFileSync(f.env, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).phase, 'running');
  assert.ok(f.commands.includes('systemctl reset-failed kakao-max.service'));
  const build = f.commands.findIndex(c => c.startsWith('runuser '));
  const start = f.commands.findIndex(c => c === 'systemctl start kakao-max.service');
  assert.ok(build >= 0 && start > build);
});

test('recovery refuses active workers, occupied endpoint, missing credentials, invalid UTF-8 and implicit recovery', async t => {
  for (const kind of ['active', 'port', 'credentials', 'utf8', 'implicit']) {
    const f = fixture(t); f.host.recover = kind !== 'implicit';
    if (kind !== 'active') f.stoppedConfigured();
    if (kind === 'port') f.busyPort();
    if (kind === 'utf8') fs.appendFileSync(f.env, Buffer.from([0xff]));
    if (kind !== 'credentials') fs.appendFileSync(f.env, '\nKAKAO_EMAIL=operator@example.test\nKAKAO_PASSWORD=fixture-password\nKAKAO_ENABLE_TOKEN_REFRESH=1\n');
    await assert.rejects(updateManaged(f.host));
    assert.ok(!f.commands.some(c => c.startsWith('systemctl start') || c.startsWith('runuser ')));
  }
});

test('generic recovery uses the stored alternate port and cannot change registered identity through login configuration', async t => {
  for (const wrongIdentity of [false, true]) {
    const f = fixture(t); f.stoppedConfigured(); f.host.recover = true;
    const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')); state.port = 8787;
    fs.writeFileSync(f.stateFile, JSON.stringify(state));
    fs.writeFileSync(f.env, f.credentials.replace('127.0.0.1:18787', '127.0.0.1:8787'));
    const host = { ...f.host, healthy: async (_id: string, port: number) => { assert.equal(port, 8787); return true; },
      configureLogin: async () => { fs.appendFileSync(f.env, '\nKAKAO_EMAIL=operator@example.test\nKAKAO_PASSWORD=fixture-password\nKAKAO_ENABLE_TOKEN_REFRESH=1\n');
        if (wrongIdentity) fs.appendFileSync(f.env, 'KAKAO_USER_ID=555555555\n'); } };
    if (wrongIdentity) { await assert.rejects(updateManaged(host), /protected account/); assert.ok(!f.commands.some(c => c.startsWith('systemctl start'))); }
    else { await updateManaged(host); assert.ok(f.commands.some(c => c.includes('sport = :8787'))); }
  }
});

function migrationFixture(t: { after(fn: () => void): void }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-migrate-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const legacyRoot = path.join(parent, 'legacy-managed'), targetRoot = path.join(parent, 'target-managed');
  const repo = path.join(parent, 'source'), legacyApp = path.join(legacyRoot, 'app'), legacyData = path.join(legacyRoot, 'data');
  fs.mkdirSync(legacyApp, { recursive: true }); fs.mkdirSync(legacyData); fs.mkdirSync(repo);
  const uid = process.getuid!() || 65000, gid = process.getgid!(), old = 'a'.repeat(40), target = 'b'.repeat(40);
  const legacyEnv = path.join(legacyApp, '.env.local');
  const legacyUnitFile = path.join(parent, 'kakaotalk-mcp.service'), targetUnitFile = path.join(parent, 'kakao-max.service');
  // Same keys setup-system writes, including the audit log inside the data dir.
  const credentials = `KAKAO_USER_ID=123456789\nKAKAO_ACCESS_TOKEN=fixture-token\nKAKAO_DATA_DIR=${legacyData}\nKAKAO_AUDIT_LOG=${legacyData}/audit.log\nKAKAO_MCP_LISTEN=127.0.0.1:18787\nKAKAO_MCP_ALLOWED_UIDS=1000\n`;
  fs.writeFileSync(legacyEnv, credentials, { mode: 0o600 }); fs.chownSync(legacyEnv, uid, gid); fs.chownSync(legacyData, uid, gid);
  fs.writeFileSync(path.join(legacyData, 'journal-marker'), 'legacy journal content');
  const stateFile = path.join(legacyRoot, 'install-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, phase: 'running', commit: old, port: 18787 }), { mode: 0o600 });
  fs.writeFileSync(legacyUnitFile, legacyServiceUnit(legacyApp, legacyData, '/usr/bin/node', 'kakaotalk-mcp'));

  const commands: string[] = []; let installed = old, active = true, healthy = true, failBuild = false, failGroupmod = false, failUsermod = false, userTaken = false, groupTaken = false;
  let userRenamed = false, groupRenamed = false;
  const targetApp = path.join(targetRoot, 'app');
  const host = {
    root: targetRoot, legacyRoot, unitFile: targetUnitFile, legacyUnitFile, service: 'kakao-max', legacyService: 'kakaotalk-mcp',
    repo, node: '/usr/bin/node', npm: '/usr/bin/npm', target, reason: 'migration to kakao-max',
    run: (program: string, args: string[]) => {
      commands.push(`${program} ${args.join(' ')}`);
      if (program === 'usermod') {
        if (failUsermod) throw new Error('fixture usermod failure');
        userRenamed = true;
      }
      if (program === 'groupmod') {
        if (failGroupmod) throw new Error('fixture groupmod failure');
        groupRenamed = true;
      }
      if (program === 'id') {
        if (args.includes('kakao-max')) {
          if (userRenamed || userTaken) return String(args.includes('-u') ? uid : gid);
          return '';
        }
        return String(args[0] === '-u' ? uid : gid);
      }
      if (program === 'getent') {
        if (args.includes('kakao-max')) {
          if (groupRenamed || groupTaken) return `kakao-max:x:${gid}:`;
          return '';
        }
        return '';
      }
      if (program === 'git') {
        if (args.includes('rev-parse')) return (args.includes(legacyApp) || args.includes(targetApp)) ? installed : target;
        if (args.includes('status')) return '';
        if (args.includes('merge-base')) return old;
        if (args.includes('checkout')) installed = target;
      }
      if (program === 'systemctl') {
        if (args[0] === 'is-active') return active ? 'active' : 'inactive';
        if (args[0] === 'stop') active = false;
        if (args[0] === 'start') active = true;
      }
      if (program === 'runuser' && failBuild) throw new Error('fixture migration build failure');
      return '';
    },
    healthy: async (expected: string) => { assert.equal(expected, '123456789'); return healthy; },
    wait: async () => {}
  };
  return { host, commands, credentials, parent, legacyRoot, targetRoot, legacyUnitFile, targetUnitFile, legacyEnv, legacyData, stateFile, uid, gid,
    failBuild: () => { failBuild = true; },
    failGroupmod: () => { failGroupmod = true; },
    failUsermod: () => { failUsermod = true; },
    unhealthy: () => { healthy = false; },
    userTaken: () => { userTaken = true; },
    groupTaken: () => { groupTaken = true; }
  };
}

test('managed migration happy path: stops old unit, disables it, moves root, renames user preserving uid/gid, rewrites KAKAO_DATA_DIR, enables and starts new unit, verifies health without re-registration', async t => {
  const f = migrationFixture(t);
  await updateManaged(f.host);

  const stopOld = f.commands.findIndex(c => c === 'systemctl stop kakaotalk-mcp.service');
  const disableOld = f.commands.findIndex(c => c === 'systemctl disable kakaotalk-mcp.service');
  const groupMod = f.commands.findIndex(c => c === 'groupmod -n kakao-max kakaotalk-mcp');
  const userMod = f.commands.findIndex(c => c === 'usermod -l kakao-max kakaotalk-mcp');
  const reload = f.commands.findIndex(c => c === 'systemctl daemon-reload');
  const enableNew = f.commands.findIndex(c => c === 'systemctl enable kakao-max.service');
  const build = f.commands.findIndex(c => c.startsWith('runuser -u kakao-max'));
  const startNew = f.commands.findIndex(c => c === 'systemctl start kakao-max.service');

  assert.ok(stopOld >= 0, 'old unit was stopped');
  assert.ok(disableOld > stopOld, 'old unit was disabled after stop');
  assert.ok(groupMod > disableOld, 'group renamed after disable');
  assert.ok(userMod > disableOld, 'user renamed after disable');
  assert.ok(reload > userMod, 'daemon-reload run after user rename');
  assert.ok(enableNew > reload, 'new unit enabled after daemon-reload');
  assert.ok(build > enableNew, 'built after enable');
  assert.ok(startNew > build, 'new unit started after build');

  assert.equal(fs.existsSync(f.legacyRoot), false, 'legacy root directory moved');
  assert.equal(fs.existsSync(f.targetRoot), true, 'target root directory exists');
  assert.equal(fs.existsSync(f.legacyUnitFile), false, 'legacy unit removed');
  assert.equal(fs.existsSync(f.targetUnitFile), true, 'target unit created');

  const newEnv = path.join(f.targetRoot, 'app', '.env.local');
  const envContent = fs.readFileSync(newEnv, 'utf8');
  assert.ok(envContent.includes(`KAKAO_DATA_DIR=${f.targetRoot}/data`), 'KAKAO_DATA_DIR was rewritten to new data dir');
  assert.ok(envContent.includes(`KAKAO_AUDIT_LOG=${f.targetRoot}/data/audit.log`), 'KAKAO_AUDIT_LOG moved with the data dir');
  assert.ok(!envContent.includes(f.legacyRoot), 'no setting names the old root');
  assert.ok(envContent.includes('KAKAO_ACCESS_TOKEN=fixture-token'), 'credentials preserved');
  assert.equal(fs.statSync(newEnv).mode & 0o777, 0o600, 'mode 600 preserved');

  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'data', 'journal-marker'), 'utf8'), 'legacy journal content');
  const finalState = JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'install-state.json'), 'utf8'));
  assert.deepEqual(finalState, { version: 1, phase: 'running', commit: f.host.target, port: 18787 });

  const deployLog = fs.readFileSync(path.join(f.targetRoot, 'deploys.log'), 'utf8');
  assert.ok(deployLog.includes('migrated from kakaotalk-mcp'), 'migration logged in deploys.log');
  assert.equal(fs.existsSync(`${f.targetRoot}.install-lock`), false, 'target lock cleaned up');
  assert.equal(fs.existsSync(`${f.legacyRoot}.install-lock`), false, 'legacy lock cleaned up');
});

test('migration refuses before stopping when a setting other than the moved paths names the old root', async t => {
  const f = migrationFixture(t);
  fs.appendFileSync(f.legacyEnv, `KAKAO_RECORD_FILE=${f.legacyData}/frames.jsonl\n`);
  await assert.rejects(updateManaged(f.host), (e: Error) => /KAKAO_RECORD_FILE/.test(e.message) && /Nothing was stopped/.test(e.message));
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
  assert.equal(fs.existsSync(f.legacyRoot), true);
});

test('migration refuses before stopping when KAKAO_AUDIT_LOG is outside the data dir', async t => {
  const f = migrationFixture(t);
  fs.writeFileSync(f.legacyEnv, f.credentials.replace(/^KAKAO_AUDIT_LOG=.*$/m, 'KAKAO_AUDIT_LOG=/elsewhere/audit.log'));
  await assert.rejects(updateManaged(f.host), (e: Error) => /KAKAO_AUDIT_LOG is not/.test(e.message));
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
});

test('migration refuses when both legacy and target roots exist, stopping nothing', async t => {
  const f = migrationFixture(t);
  fs.mkdirSync(f.targetRoot);
  await assert.rejects(updateManaged(f.host), { code: 'CONFIG_INVALID' });
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
  assert.equal(fs.existsSync(f.legacyRoot), true);
});

test('migration refuses when both legacy and target unit files exist, stopping nothing', async t => {
  const f = migrationFixture(t);
  fs.writeFileSync(f.targetUnitFile, 'fixture');
  await assert.rejects(updateManaged(f.host), { code: 'CONFIG_INVALID' });
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
});

test('migration refuses when target user or group already exists, stopping nothing', async t => {
  const fUser = migrationFixture(t);
  fUser.userTaken();
  await assert.rejects(updateManaged(fUser.host), (e: Error) => /Target user kakao-max already exists/.test(e.message));
  assert.ok(!fUser.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');

  const fGroup = migrationFixture(t);
  fGroup.groupTaken();
  await assert.rejects(updateManaged(fGroup.host), (e: Error) => /Target group kakao-max already exists/.test(e.message));
  assert.ok(!fGroup.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
});

test('migration refuses when legacy install is paused, stopping nothing', async t => {
  const f = migrationFixture(t);
  fs.writeFileSync(path.join(f.legacyData, 'operator-paused'), 'pause marker');
  await assert.rejects(updateManaged(f.host), { code: 'POLICY_DENIED' });
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
});

test('migration refuses when legacy unit file is missing, stopping nothing', async t => {
  const f = migrationFixture(t);
  fs.unlinkSync(f.legacyUnitFile);
  await assert.rejects(updateManaged(f.host), { code: 'CONFIG_INVALID' });
  assert.ok(!f.commands.some(c => c.startsWith('systemctl stop')), 'nothing stopped');
});

test('migration failure at build after full migration advises recover-managed-mcp without suggesting enable --now', async t => {
  const f = migrationFixture(t);
  f.failBuild();
  await assert.rejects(updateManaged(f.host), (e: any) => {
    assert.equal(e.code, 'STORAGE_UNSAFE');
    assert.match(e.message, /Migration finished; build failed\. From the published checkout run: sudo node .*update-managed\.ts --via-deploy [a-f0-9]{40} "<reason>" --recover/);
    assert.ok(!e.message.includes('enable --now'), 'does not suggest enable --now');
    return true;
  });
  assert.ok(f.commands.includes('systemctl stop kakaotalk-mcp.service'), 'old unit was stopped');
  assert.ok(!f.commands.includes('systemctl start kakao-max.service'), 'new unit was not started');
  assert.ok(!f.commands.includes('systemctl start kakaotalk-mcp.service'), 'old unit was not restarted (no concurrent or blind restarts)');
});

test('migration failure right after disable advises sudo systemctl enable --now kakaotalk-mcp.service', async t => {
  const f = migrationFixture(t);
  const origRun = f.host.run;
  f.host.run = (program: string, args: string[]) => {
    const out = origRun(program, args);
    if (program === 'systemctl' && args[0] === 'disable') {
      fs.writeFileSync(`${f.targetRoot}.install-lock`, 'lock created right after disable');
    }
    return out;
  };
  await assert.rejects(updateManaged(f.host), (e: any) => {
    assert.equal(e.code, 'STORAGE_UNSAFE');
    assert.match(e.message, /Migration halted at "acquire target lock/);
    assert.match(e.message, /sudo systemctl enable --now kakaotalk-mcp\.service/);
    assert.equal(fs.existsSync(f.legacyRoot), true, 'legacy root remains');
    assert.equal(fs.existsSync(f.targetRoot), false, 'target root was not created');
    return true;
  });
  assert.ok(f.commands.includes('systemctl stop kakaotalk-mcp.service'), 'old unit was stopped');
  assert.ok(f.commands.includes('systemctl disable kakaotalk-mcp.service'), 'old unit was disabled');
  assert.ok(!f.commands.includes('systemctl start kakao-max.service'), 'new unit was not started');
  assert.ok(!f.commands.includes('systemctl start kakaotalk-mcp.service'), 'old unit was not restarted');
});

test('migration failure during usermod after root rename stops daemon and lists only pending renames', async t => {
  const f = migrationFixture(t);
  f.failUsermod();
  await assert.rejects(updateManaged(f.host), (e: any) => {
    assert.equal(e.code, 'STORAGE_UNSAFE');
    assert.match(e.message, /Migration halted at "usermod -l kakao-max kakaotalk-mcp"/);
    assert.match(e.message, /Completed: \[.*rename root directory.*\]/);
    assert.match(e.message, /Root was moved to/);
    assert.match(e.message, /sudo usermod -l kakao-max kakaotalk-mcp/);
    assert.ok(!e.message.includes('sudo groupmod'), 'completed groupmod is not listed');
    return true;
  });
  assert.equal(fs.existsSync(f.targetRoot), true, 'target root directory exists because move completed');
  assert.equal(fs.existsSync(f.legacyRoot), false, 'legacy root was moved');
  assert.ok(f.commands.includes('systemctl stop kakaotalk-mcp.service'), 'old unit was stopped');
  assert.ok(!f.commands.includes('systemctl start kakao-max.service'), 'new unit was not started');
  assert.ok(!f.commands.includes('systemctl start kakaotalk-mcp.service'), 'old unit was not restarted');
});

test('migration failure during groupmod lists both groupmod and usermod', async t => {
  const f = migrationFixture(t);
  f.failGroupmod();
  await assert.rejects(updateManaged(f.host), (e: any) => {
    assert.equal(e.code, 'STORAGE_UNSAFE');
    assert.match(e.message, /Migration halted at "groupmod -n kakao-max kakaotalk-mcp"/);
    assert.match(e.message, /sudo groupmod -n kakao-max kakaotalk-mcp && sudo usermod -l kakao-max kakaotalk-mcp/);
    return true;
  });
});

test('migration failure if credentials in .env.local are modified beyond KAKAO_DATA_DIR throws STORAGE_UNSAFE', async t => {
  const f = migrationFixture(t);
  let tampered = false;
  const originalRun = f.host.run;
  f.host.run = (program: string, args: string[]) => {
    if (program === 'systemctl' && args[0] === 'daemon-reload' && !tampered) {
      tampered = true;
      const targetEnv = path.join(f.targetRoot, 'app', '.env.local');
      fs.appendFileSync(targetEnv, 'TAMPERED=1\n');
    }
    return originalRun(program, args);
  };
  await assert.rejects(updateManaged(f.host), { code: 'STORAGE_UNSAFE' });
  assert.ok(!f.commands.includes('systemctl start kakao-max.service'), 'new unit was not started');
});
