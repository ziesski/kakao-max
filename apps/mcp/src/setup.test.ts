import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectionConfig, runSetup, saveConnection, resolveClientConfigFile, registrationHint, modeSettingsTarget, MANAGED_ENV } from './setup.ts';
import { confirmSetup } from './setup-prompts.ts';

test('setup confirmations accept simple answers and Enter defaults, and retry invalid input', async () => {
  for (const [answer, expected] of [['y', true], [' Y ', true], ['yes', true], ['N', false], ['no', false], ['', false]] as const) {
    assert.equal(await confirmSetup(async () => answer, '계속할까요?'), expected);
  }
  assert.equal(await confirmSetup(async () => '', '시작할까요?', true), true);
  const answers = ['invalid', 'n'], questions: string[] = [];
  assert.equal(await confirmSetup(async question => { questions.push(question); return answers.shift()!; }, '계속할까요?', true), false);
  assert.match(questions[0], /\[Y\/n\]/);
  assert.match(questions[1], /Y 또는 N/);
});

test('remote MCP settings use SSH stdio forwarding with no remote command or credentials', () => {
  const config = connectionConfig({ ssh: 'operator@example.test' }).mcpServers['kakao-max'];
  assert.equal(config.command, process.execPath); assert.ok(config.args.includes('--resilient')); assert.deepEqual(config.args.slice(-2), ['--ssh', 'operator@example.test']);
  for (const bad of ['-oProxyCommand=bad','user@host;id','user@host x','$(id)','user@-flag']) {
    assert.throws(() => connectionConfig({ ssh: bad }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => connectionConfig({ ssh: 'host', listen: '0.0.0.0:8787' }), { code: 'CONFIG_INVALID' });
  const local = connectionConfig({ repo: '/tmp/fixture repo', node: '/usr/bin/node' }).mcpServers['kakao-max'];
  assert.equal(local.command, '/usr/bin/node'); assert.ok(local.args.includes(path.join('/tmp/fixture repo', 'apps/mcp/src/connect.ts')));
  assert.ok(!JSON.stringify(local).includes('src/index.ts'));
});

test('existing-daemon wizard never invokes install/login and does not edit an AI application settings file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-connect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings/mcp.json'), answers = ['1','operator@server.test', '127.0.0.1:18787'];
  let installs = 0, output = '';
  await runSetup({ repo: root, platform: 'linux', configFile: file, prompt: async () => answers.shift()!,
    log: () => {}, output: s => { output = s; }, install: () => { installs++; return true; } });
  assert.equal(installs, 0); if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(output).mcpServers['kakao-max'].command, process.execPath);
  assert.ok(JSON.parse(output).mcpServers['kakao-max'].args.includes('127.0.0.1:18787'));
  assert.deepEqual(fs.readdirSync(root), ['settings']);
});

test('connection settings are idempotent and cannot overwrite another config or follow a symlink without review', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mcp.json'), old = connectionConfig({ ssh: 'old.test' }), next = connectionConfig({ ssh: 'new.test' });
  const decline = async () => '';
  await saveConnection(file, old, decline); await saveConnection(file, old, async () => { throw new Error('must not ask'); });
  await assert.rejects(saveConnection(file, next, decline), { code: 'POLICY_DENIED' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old);
  await saveConnection(file, next, async () => 'y');
  if (process.platform !== 'win32') { fs.symlinkSync(file, path.join(root, 'link.json'));
  await assert.rejects(saveConnection(path.join(root, 'link.json'), old, async () => 'y'), { code: 'CONFIG_INVALID' }); }
});

test('new install requires Linux and a simple confirmation, and noninteractive default setup exits without secrets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let installs = 0;
  const deps = { repo: root, platform: 'linux', configFile: path.join(root, 'mcp.json'), log: () => {}, output: () => {}, install: () => { installs++; return true; } };
  const answers = ['2','n'];
  await runSetup({ ...deps, prompt: async () => answers.shift()! }); assert.equal(installs, 0);
  const preparedOnly = ['2',''];
  await runSetup({ ...deps, prompt: async () => preparedOnly.shift()!, install: () => false });
  assert.ok(!fs.existsSync(deps.configFile));
  await assert.rejects(runSetup({ ...deps, platform: 'darwin', prompt: async () => '2' }), { code: 'CONFIG_INVALID' });
  const script = fileURLToPath(new URL('./setup.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(!fs.existsSync(deps.configFile));
  const config = spawnSync(process.execPath, ['--experimental-strip-types', script, '--config','--ssh','server.test'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(config.status, 0); assert.equal(JSON.parse(config.stdout).mcpServers['kakao-max'].command, process.execPath);
  const alternate = spawnSync(process.execPath, ['--experimental-strip-types', script, '--config','--ssh','server.test','--listen','127.0.0.1:18787'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(alternate.status, 0);
  assert.ok(JSON.parse(alternate.stdout).mcpServers['kakao-max'].args.includes('127.0.0.1:18787'));
  const exposed = spawnSync(process.execPath, ['--experimental-strip-types', script, '--config','--listen','0.0.0.0:18787'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(exposed.status, 1); assert.equal(exposed.stdout, '');
});

test('new-user wizard carries an alternate installation port into connection settings and diagnoses it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-port-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const answers = ['2', 'y', '18787', '', '']; let installedPort: number | undefined, diagnosed = '';
  await runSetup({ repo: root, platform: 'linux', configFile: path.join(root, 'settings/mcp.json'), prompt: async () => answers.shift() ?? '',
    install: port => { installedPort = port; return true; }, log: () => {}, output: () => {},
    diagnose: async options => { diagnosed = options.listen; return { status: 'ready', connected: true, nextAction: 'fixture' }; } });
  assert.equal(installedPort, 18787); assert.equal(diagnosed, '127.0.0.1:18787');
});

test('right after a server install the wizard asks no SSH questions and prints ready-to-run client commands', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-installed-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asked: string[] = [], logs: string[] = [], answers = ['2', 'y', '18787'];
  let output = '';
  await runSetup({ repo: root, platform: 'linux', configFile: path.join(root, 'settings/mcp.json'),
    prompt: async q => { asked.push(q); return answers.shift() ?? ''; }, install: () => true, log: s => logs.push(s), output: s => { output = s; } });
  assert.equal(asked.length, 3, 'only the choice, the install confirmation and the port');
  const args = JSON.parse(output).mcpServers['kakao-max'].args as string[];
  assert.ok(args.includes('127.0.0.1:18787')); assert.ok(!args.includes('--ssh'));
  const text = logs.join('\n');
  assert.match(text, /claude mcp add --scope user kakao-max -- /); assert.match(text, /codex mcp add kakao-max -- /);
  assert.match(text, /--config --ssh <이 서버의 SSH 대상> --listen 127\.0\.0\.1:18787/);
});

test('client commands quote paths with spaces for the platform shell', () => {
  const config = { mcpServers: { 'kakao-max': { command: '/opt/my node/bin/node', args: ['connect.mjs', '--listen', '127.0.0.1:8787', "it's"] } } };
  assert.ok(registrationHint(config, 'linux').includes(`-- '/opt/my node/bin/node' connect.mjs --listen 127.0.0.1:8787 'it'\\''s'`));
  const win = { mcpServers: { 'kakao-max': { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--listen', '127.0.0.1:8787'] } } };
  assert.ok(registrationHint(win, 'win32').includes('-- "C:\\Program Files\\nodejs\\node.exe" --listen 127.0.0.1:8787'));
});

test('--mode writes the managed daemon settings on an installed server, through sudo when not root', () => {
  const nearest = () => '/home/fixture/checkout/.env.local';
  assert.deepEqual(modeSettingsTarget({ platform: 'linux', managedInstalled: true, isRoot: false, nearest }), { envPath: MANAGED_ENV, managed: true, needsSudo: true });
  assert.deepEqual(modeSettingsTarget({ platform: 'linux', managedInstalled: true, isRoot: true, nearest }), { envPath: MANAGED_ENV, managed: true, needsSudo: false });
  assert.deepEqual(modeSettingsTarget({ platform: 'linux', managedInstalled: false, isRoot: false, nearest }), { envPath: nearest(), managed: false, needsSudo: false });
  assert.deepEqual(modeSettingsTarget({ platform: 'darwin', managedInstalled: true, isRoot: false, nearest }), { envPath: nearest(), managed: false, needsSudo: false });
  assert.deepEqual(modeSettingsTarget({ env: '/tmp/x/.env.local', platform: 'linux', managedInstalled: true, isRoot: false, nearest }), { envPath: '/tmp/x/.env.local', managed: false, needsSudo: false });
});

test('resolveClientConfigFile defaults to kakao-max and falls back to legacy kakaotalk-mcp when only legacy exists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cfg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. Fresh: neither exists -> returns .config/kakao-max/mcp.json (not fallback)
  const fresh = resolveClientConfigFile(root);
  assert.equal(fresh.file, path.join(root, '.config/kakao-max/mcp.json'));
  assert.equal(fresh.isFallback, false);

  // 2. Only legacy exists: returns legacy path with isFallback: true
  const legacyDir = path.join(root, '.config/kakaotalk-mcp');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'mcp.json'), '{}');
  const legacy = resolveClientConfigFile(root);
  assert.equal(legacy.file, path.join(legacyDir, 'mcp.json'));
  assert.equal(legacy.isFallback, true);

  // 3. New exists: returns new path with isFallback: false even if legacy also exists
  const newDir = path.join(root, '.config/kakao-max');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'mcp.json'), '{}');
  const migrated = resolveClientConfigFile(root);
  assert.equal(migrated.file, path.join(newDir, 'mcp.json'));
  assert.equal(migrated.isFallback, false);
});
