import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, describeConfig, parseApprovalConfig, parseMcpToolGroups, parseRecipientLimit, parseAddFriendLimit, resetLegacyDataDirNoticeForTests } from './config.ts';
import { KakaoError, toKakaoError, locoStatusError } from './errors.ts';
import { LocoError } from '@kakao-max/protocol';

const NO_FILE = path.join(os.tmpdir(), 'definitely-missing', '.env.local');

test('loadConfig applies defaults', () => {
  const c = loadConfig({ envPath: NO_FILE, env: {} });
  assert.deepEqual(c.client, { appVersion: '26.4.0', os: 'mac', lang: 'ko', timeZone: 'Asia/Seoul' });
  assert.equal(c.tokenRefresh.enabled, false);
  assert.ok(!describeConfig(c).includes('TOKEN'));
});

test('dataDir defaults to ~/.kakao-max on fresh install and falls back to ~/.kakao when existing', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-cfg-'));
  try {
    // 1. Fresh home: neither exists -> ~/.kakao-max (no empty folder created by loadConfig)
    const fresh = loadConfig({ envPath: NO_FILE, env: {}, homedir: tempHome });
    assert.equal(fresh.dataDir, path.join(tempHome, '.kakao-max'));
    assert.equal(fs.existsSync(path.join(tempHome, '.kakao-max')), false, 'loadConfig must never create the directory');

    // 2. Existing ~/.kakao and no ~/.kakao-max: keep using ~/.kakao and print one notice
    const legacyDir = path.join(tempHome, '.kakao');
    fs.mkdirSync(legacyDir);
    resetLegacyDataDirNoticeForTests();

    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
    try {
      const legacyFirst = loadConfig({ envPath: NO_FILE, env: {}, homedir: tempHome });
      assert.equal(legacyFirst.dataDir, legacyDir);
      assert.equal(fs.existsSync(path.join(tempHome, '.kakao-max')), false, 'never create empty store next to existing');
      assert.equal(errLines.length, 1);
      assert.ok(errLines[0].includes('Using the legacy data directory'));
      assert.equal(errLines[0].includes(tempHome), false);

      // Calling again does not print the notice again
      const legacySecond = loadConfig({ envPath: NO_FILE, env: {}, homedir: tempHome });
      assert.equal(legacySecond.dataDir, legacyDir);
      assert.equal(errLines.length, 1, 'notice printed only once');
    } finally {
      console.error = origError;
    }

    // 3. If ~/.kakao-max exists (migrated), it wins even if ~/.kakao also exists
    const newDir = path.join(tempHome, '.kakao-max');
    fs.mkdirSync(newDir);
    const migrated = loadConfig({ envPath: NO_FILE, env: {}, homedir: tempHome });
    assert.equal(migrated.dataDir, newDir);

    // 4. KAKAO_DATA_DIR in env always wins over both
    const custom = loadConfig({ envPath: NO_FILE, env: { KAKAO_DATA_DIR: '/custom/path' }, homedir: tempHome });
    assert.equal(custom.dataDir, path.resolve('/custom/path'));
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('process env overrides .env.local, which overrides defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, 'KAKAO_APP_VERSION=26.5.0\nKAKAO_ENABLE_TOKEN_REFRESH=1\nKAKAO_DATA_DIR=/tmp/a\n');
  const c = loadConfig({ envPath, env: { KAKAO_DATA_DIR: '/tmp/b' } });
  assert.equal(c.client.appVersion, '26.5.0');
  assert.equal(c.tokenRefresh.enabled, true);
  assert.equal(c.dataDir, path.resolve('/tmp/b'));
  assert.equal(loadConfig({ envPath, env: { KAKAO_TIMEZONE: 'America/Los_Angeles' } }).client.timeZone, 'America/Los_Angeles');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid values fail fast with CONFIG_INVALID', () => {
  for (const env of [{ KAKAO_APP_VERSION: 'latest' }, { KAKAO_CLIENT_OS: 'android' }, { KAKAO_LANG: 'korean' }, { KAKAO_TIMEZONE: 'Mars/Olympus' }]) {
    assert.throws(() => loadConfig({ envPath: NO_FILE, env }), (e: unknown) => e instanceof KakaoError && e.code === 'CONFIG_INVALID');
  }
});

test('removed settings fail closed instead of being silently ignored', () => {
  assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_MCP_PERMISSION_MODEL: 'rooms' } }),
    (e: unknown) => e instanceof KakaoError && e.code === 'CONFIG_INVALID' && /was removed/.test(e.message));
});

test('KakaoError defaults retryable by code and serializes', () => {
  assert.equal(new KakaoError('NOT_CONNECTED', 'x').retryable, true);
  assert.equal(new KakaoError('POLICY_DENIED', 'x').retryable, false);
  assert.deepEqual(locoStatusError('WRITE', -500).toJSON(), {
    code: 'LOCO_STATUS',
    message: 'WRITE failed with status -500',
    retryable: false,
    details: { command: 'WRITE', status: -500 }
  });
});

test('toKakaoError maps socket errors to NETWORK and the rest to INTERNAL', () => {
  const sock = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(toKakaoError(sock).code, 'NETWORK');
  assert.equal(toKakaoError(sock).retryable, true);
  assert.equal(toKakaoError(new Error('boom')).code, 'INTERNAL');
  assert.equal(toKakaoError('weird').message, 'Unexpected internal error');
  const k = new KakaoError('NOT_FOUND', 'nope');
  assert.equal(toKakaoError(k), k);
});

test('toKakaoError maps protocol LocoError codes', () => {
  const cases: Array<[LocoError, string, boolean]> = [
    [new LocoError('NOT_CONNECTED', 'x'), 'NOT_CONNECTED', true],
    [new LocoError('CLOSED', 'x', { command: 'WRITE' }), 'NOT_CONNECTED', true],
    [new LocoError('TIMEOUT', 'x', { command: 'SYNCMSG' }), 'NETWORK', true],
    [new LocoError('UNREACHABLE', 'x'), 'NETWORK', true],
    [new LocoError('STATUS', 'x', { command: 'LOGINLIST', status: -950 }), 'AUTH_EXPIRED', false],
    [new LocoError('STATUS', 'x', { command: 'SHIP', status: -500 }), 'LOCO_STATUS', false],
    [new LocoError('MALFORMED', 'x'), 'INTERNAL', false],
    [new LocoError('INVALID_ARGUMENT', 'x'), 'INVALID_ARGUMENT', false]
  ];
  for (const [err, code, retryable] of cases) {
    const k = toKakaoError(err);
    assert.equal(k.code, code, err.code);
    assert.equal(k.retryable, retryable, err.code);
    assert.equal(k.details?.locoCode, err.code);
  }
  assert.deepEqual(toKakaoError(new LocoError('STATUS', 'x', { command: 'SHIP', status: -500 })).details, { command: 'SHIP', status: -500, locoCode: 'STATUS' });
});


test('MCP listener is loaded centrally, with stdio as the default', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, '.env.local');
  assert.equal(loadConfig({ envPath, env: {} }).mcpListen, undefined);
  fs.writeFileSync(envPath, 'KAKAO_MCP_LISTEN=127.0.0.1:8787\n');
  assert.equal(loadConfig({ envPath, env: {} }).mcpListen, '127.0.0.1:8787');
  assert.equal(loadConfig({ envPath, env: { KAKAO_MCP_LISTEN: '  [::1]:8787  ' } }).mcpListen, '[::1]:8787');
});


test('the removed offline signer key fails closed', () => {
  assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_AGENT_APPROVAL_PUBLIC_KEY_FILE: '/tmp/fixture-operator.pub' } }),
    (e: unknown) => e instanceof KakaoError && e.code === 'CONFIG_INVALID');
});

test('approval listener binds loopback only and needs an exact https origin, or http on localhost', () => {
  assert.deepEqual(parseApprovalConfig(undefined, undefined, undefined), { notify: true, windowMinutes: 15, actionWindowMinutes: {}, clientConfirm: true });
  assert.deepEqual(parseApprovalConfig('127.0.0.1:8788', 'http://localhost:8788', 'off', '20', '{"leave_chat":5}'),
    { listen: '127.0.0.1:8788', origin: 'http://localhost:8788', notify: false, windowMinutes: 20, actionWindowMinutes: { leave_chat: 5 }, clientConfirm: true });
  assert.equal(parseApprovalConfig(undefined, undefined, undefined, undefined, undefined, 'off').clientConfirm, false);
  for (const [w, a] of [['4', undefined], ['31', undefined], ['7.5', undefined], [undefined, '{"leave_chat":31}'], [undefined, '[5]'], [undefined, '{"Bad-Name":5}']])
    assert.throws(() => parseApprovalConfig(undefined, undefined, undefined, w, a), { code: 'CONFIG_INVALID' }, `${w} ${a}`);
  assert.equal(parseApprovalConfig('127.0.0.1:8788', 'https://box.example.ts.net', undefined).origin, 'https://box.example.ts.net');
  for (const [listen, origin] of [['0.0.0.0:8788', 'http://localhost:8788'], ['127.0.0.1:8788', undefined], [undefined, 'http://localhost:8788'],
    ['127.0.0.1:8788', 'http://box.example.ts.net'], ['127.0.0.1:8788', 'https://box.example.ts.net/approve'], ['127.0.0.1:99999', 'http://localhost:8788']])
    assert.throws(() => parseApprovalConfig(listen, origin, undefined), { code: 'CONFIG_INVALID' }, `${listen} ${origin}`);
});

test('MCP tool groups default to none and reject unknown names; the old profile key fails closed; recipient daily limit is bounded', () => {
  assert.deepEqual(parseMcpToolGroups(undefined), []); assert.deepEqual(parseMcpToolGroups(' Chats, friends chats '), ['chats', 'friends']);
  // Names other than the built-in groups belong to optional modules; the MCP app refuses ones that are not installed.
  assert.deepEqual(parseMcpToolGroups('chats,admin'), ['chats', 'admin']);
  for (const bad of ['chats,a/b', '9x', 'x'.repeat(40)]) assert.throws(() => parseMcpToolGroups(bad), { code: 'CONFIG_INVALID' });
  assert.deepEqual(loadConfig({ envPath: NO_FILE, env: { KAKAO_MCP_TOOL_GROUPS: 'example' } }).mcpToolGroups, ['example']);
  assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_MCP_PROFILE: 'full' } }), { code: 'CONFIG_INVALID' });
  assert.equal(parseRecipientLimit(undefined), 50); assert.equal(parseRecipientLimit('10'), 10);
  for (const bad of ['0', '501', '2.5', 'many']) assert.throws(() => parseRecipientLimit(bad), { code: 'CONFIG_INVALID' });
});

test('the add_friend daily cap defaults to 10 in both modes and is bounded to 1–100', () => {
  assert.equal(parseAddFriendLimit(undefined), 10); assert.equal(parseAddFriendLimit(' 3 '), 3);
  for (const mode of ['ask', 'trust']) assert.equal(loadConfig({ envPath: NO_FILE, env: { KAKAO_AGENT_MODE: mode } }).addFriendDailyLimit, 10, mode);
  assert.equal(loadConfig({ envPath: NO_FILE, env: { KAKAO_ADD_FRIEND_DAILY_LIMIT: '25' } }).addFriendDailyLimit, 25);
  for (const bad of ['0', '101', '2.5', 'many']) assert.throws(() => parseAddFriendLimit(bad), { code: 'CONFIG_INVALID' });
});

test('automatic re-login attempts are bounded to at most three', () => {
  assert.equal(loadConfig({ envPath: NO_FILE, env: {} }).tokenRefresh.maxAttempts, 3);
  for (const value of ['1', '2', '3']) assert.equal(loadConfig({ envPath: NO_FILE, env: { KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS: value } }).tokenRefresh.maxAttempts, Number(value));
  for (const value of ['0', '4', '-1', '1.5', 'unlimited']) assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS: value } }), /KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS/);
});

test('account and uncertain-operation errors provide recovery steps without weakening permissions', () => {
  assert.equal(new KakaoError('AUTH_EXPIRED', 'fixture').toJSON().recovery?.action, 'repair_saved_login');
  assert.equal(new KakaoError('PC_SESSION_CONFLICT', 'fixture').toJSON().recovery?.action, 'ask_account_owner');
  const unknown = new KakaoError('SEND_OUTCOME_UNKNOWN', 'fixture').toJSON();
  assert.equal(unknown.retryable, false); assert.equal(unknown.recovery?.action, 'inspect_existing_operation');
  assert.equal(new KakaoError('POLICY_DENIED', 'fixture').toJSON().retryable, false);
});

test('loadConfig resolves credentials, policy, data directory and health timeout through the same boundary without logging secrets', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-config-')), envPath = path.join(dir, '.env.local');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(envPath, 'KAKAO_USER_ID=123456789\nKAKAO_ACCESS_TOKEN=fixture-token\nKAKAO_REGISTERED_DEVICE_UUID=fixture-device\nKAKAO_PASSWORD=fixture-secret\nKAKAO_ROOM_CEILING=123456789\nKAKAO_PAUSED=1\nKAKAO_MCP_HEALTH_TIMEOUT_MS=2500\n');
  const config = loadConfig({ envPath, env: { KAKAO_DATA_DIR: dir, KAKAO_MCP_HEALTH_TIMEOUT_MS: '3000' } });
  assert.equal(config.credentials.accessToken, 'fixture-token'); assert.equal(config.credentials.password, 'fixture-secret');
  assert.equal(config.dataDir, dir); assert.equal(config.healthTimeoutMs, 3000);
  assert.deepEqual(config.policy.ceiling, ['123456789']); assert.equal(config.policy.pausedAtStart, true);
  assert.equal(describeConfig(config).includes('fixture-secret'), false);
  assert.equal(describeConfig(config).includes(dir), false);
  for (const value of ['0', '-1', '120001']) assert.throws(() => loadConfig({ envPath, env: { KAKAO_MCP_HEALTH_TIMEOUT_MS: value } }), { code: 'CONFIG_INVALID' });
});

test('CLI MCP endpoint keeps its defaults and resolves file settings before environment overrides', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env.local');
  const defaults = loadConfig({ envPath, env: {} });
  assert.equal(defaults.mcpHost, '127.0.0.1');
  assert.equal(defaults.mcpPort, 8787);
  fs.writeFileSync(envPath, 'MCP_HOST=localhost\nMCP_PORT=18787\n');
  const fromFile = loadConfig({ envPath, env: {} });
  assert.equal(fromFile.mcpHost, 'localhost');
  assert.equal(fromFile.mcpPort, 18787);
  const overridden = loadConfig({ envPath, env: { MCP_HOST: '::1', MCP_PORT: '65535' } });
  assert.equal(overridden.mcpHost, '::1');
  assert.equal(overridden.mcpPort, 65535);
  const empty = loadConfig({ envPath, env: { MCP_HOST: '', MCP_PORT: '' } });
  assert.equal(empty.mcpHost, '127.0.0.1');
  assert.equal(empty.mcpPort, 8787);
});

test('CLI MCP port accepts both socket boundaries and rejects invalid port numbers', () => {
  for (const value of ['1', '65535']) {
    assert.equal(loadConfig({ envPath: NO_FILE, env: { MCP_PORT: value } }).mcpPort, Number(value));
  }
  for (const value of ['0', '65536', '-1', '8787.5', 'NaN', 'Infinity', 'port', ' ']) {
    assert.throws(() => loadConfig({ envPath: NO_FILE, env: { MCP_PORT: value } }), { code: 'CONFIG_INVALID' }, value);
  }
});

test('CLI MCP host accepts hostnames and IPs but rejects URL and whitespace inputs', () => {
  for (const value of ['localhost', '127.0.0.1', '::1', 'daemon.example.test']) {
    assert.equal(loadConfig({ envPath: NO_FILE, env: { MCP_HOST: value } }).mcpHost, value);
  }
  for (const value of ['http://localhost', 'local host', 'host/path', 'host?query', 'user@host', 'host#fragment', 'host\\path']) {
    assert.throws(() => loadConfig({ envPath: NO_FILE, env: { MCP_HOST: value } }), { code: 'CONFIG_INVALID' }, value);
  }
});

test('owner read connection config is explicit argv, mutually exclusive and never a role flag', () => {
  const config = loadConfig({ envPath: NO_FILE, env: { KAKAO_USER_COMMAND: '["ssh","-T","server.test","kakao-max","user-connect"]' } });
  assert.deepEqual(config.userCommand, ['ssh', '-T', 'server.test', 'kakao-max', 'user-connect']);
  for (const value of ['"shell command"', '[]', '["ssh",42]', '["ssh","bad\\narg"]']) {
    assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_USER_COMMAND: value } }), { code: 'CONFIG_INVALID' });
  }
  assert.throws(() => loadConfig({ envPath: NO_FILE, env: { KAKAO_USER_SOCKET: '/fixture', KAKAO_USER_COMMAND: '["fixture"]' } }), { code: 'CONFIG_INVALID' });
});
