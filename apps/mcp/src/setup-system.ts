#!/usr/bin/env node
// New self-hosted installation only. Entry point: sudo scripts/install.sh bootstrap (npm run setup runs it).
// All OS/account effects are injected so tests never install services or contact Kakao.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { KakaoDeviceRegistration, type SignRegistrationResult } from '@kakao-max/protocol';
import { KakaoError } from '@kakao-max/core';
import { confirmSetup, terminalPrompt, type SetupPrompt } from './setup-prompts.ts';
import { probe } from './healthcheck.ts';
import { parseEnv } from '../../../packages/core/src/env-file.ts';

const SERVICE = 'kakao-max';
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
interface InstallState { version: 1; commit: string; phase: 'building' | 'prepared' | 'configured' | 'running'; port?: number; deviceUuid?: string }
export interface BootstrapHost {
  repo: string; root: string; unitFile: string; node: string; npm: string;
  run(program: string, args: string[], allowFailure?: boolean, cwd?: string): string;
  prompt: SetupPrompt; log(text: string): void;
  register(email: string, password: string, uuid: string, takeover: boolean): Promise<SignRegistrationResult>;
  occupied(): Promise<boolean>; healthy(expectedUserId: string): Promise<boolean>; wait(ms: number): Promise<void>;
  reason: string;
  port?: number;
  /** The human who ran setup with sudo (SUDO_UID): their SSH tunnel is the one the daemon serves. */
  operatorUid?: number;
  /** Internal isolation for explicit OS tests; the CLI always uses kakao-max. */
  serviceName?: string;
}

function ownerPath(file: string, directory = false, uid = process.getuid?.()): void {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== uid || (s.mode & 0o022)) {
    throw new KakaoError('STORAGE_UNSAFE', 'Installer paths must be owned and protected from other users');
  }
}

function writePrivate(file: string, text: string, uid = process.getuid!(), gid = process.getgid!()): void {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fchownSync(fd, uid, gid); fs.fsyncSync(fd); }
  catch (e) { fs.unlinkSync(temp); throw e; }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (e) { fs.unlinkSync(temp); throw e; }
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function serviceUnit(app: string, data: string, node: string, service = SERVICE, description = 'kakao-max account daemon'): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(service)) throw new KakaoError('CONFIG_INVALID', 'Invalid service identity');
  for (const value of [app, data, node]) if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new KakaoError('CONFIG_INVALID', 'Service paths must be absolute and contain no control characters');
  }
  const quote = (v: string, command = false) => {
    if (/[\x00-\x1f\x7f]/.test(v)) throw new KakaoError('CONFIG_INVALID', 'Invalid service path');
    const escaped = v.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${command ? escaped.replace(/\$/g, () => '$$') : escaped}"`;
  };
  // Unlike ExecStart/ReadWritePaths, WorkingDirectory consumes one path, not a quoted word list.
  return `[Unit]\nDescription=${description}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=${service}\nGroup=${service}\nWorkingDirectory=${app.replace(/%/g, '%%')}\nExecStart=${quote(node, true)} --experimental-strip-types apps/mcp/src/index.ts\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${quote(data)} ${quote(path.join(app, '.env.local'))}\nCapabilityBoundingSet=\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function legacyServiceUnit(app: string, data: string, node: string, service = 'kakaotalk-mcp'): string {
  return serviceUnit(app, data, node, service, 'KakaoTalk MCP account daemon');
}

export function installPort(value: string): number {
  if (!/^[1-9]\d{3,4}$/.test(value) || Number(value) > 65535 || Number(value) < 1024) {
    throw new KakaoError('CONFIG_INVALID', 'MCP port must be an integer from 1024 to 65535');
  }
  return Number(value);
}

/** Only bootstrap our own manifest. Legacy service/configuration is never adopted or restarted. */
export async function bootstrapLocal(h: BootstrapHost): Promise<'ready' | 'configured' | 'cancelled'> {
  const port = installPort(String(h.port ?? 8787)), listen = `127.0.0.1:${port}`;
  const service = h.serviceName ?? SERVICE, unit = `${service}.service`;
  if (!/^kakao-max(?:-[a-f0-9]{8})?$/.test(service)) throw new KakaoError('CONFIG_INVALID', 'Invalid managed service identity');
  if (!h.reason.trim() || h.reason.length > 256 || /[\x00-\x1f\x7f]/.test(h.reason)) throw new KakaoError('INVALID_ARGUMENT', 'A short deployment reason is required');
  ownerPath(path.dirname(h.root), true);
  const lock = `${h.root}.install-lock`;
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new KakaoError('WORKER_IN_USE', 'Another install or an interrupted install holds the lock; inspect it before retrying'); }
  try {
    fs.writeSync(lockFd, `${process.pid}\n`); fs.fsyncSync(lockFd);
    // Root must not refresh/rewrite the invoking user's index during a read-only status check.
    const git = (...args: string[]) => h.run('git', ['--no-optional-locks', '-c', `safe.directory=${h.repo}`, '-C', h.repo, ...args]).trim();
    const commit = git('rev-parse', 'origin/main');
    if (!/^[a-f0-9]{40}$/.test(commit) || git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain')) {
      throw new KakaoError('CONFIG_INVALID', 'Bootstrap requires a clean checkout at origin/main. Publish/merge code first; branches are not installed.');
    }
    const stateFile = path.join(h.root, 'install-state.json'), app = path.join(h.root, 'app'), data = path.join(h.root, 'data');
    let state: InstallState;
    if (fs.existsSync(h.root)) {
      ownerPath(h.root, true); ownerPath(stateFile);
      const stat = fs.statSync(stateFile);
      if ((stat.mode & 0o077) || stat.size > 4096) throw new KakaoError('STORAGE_UNSAFE', 'Unsafe installer manifest');
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.version !== 1 || !/^[a-f0-9]{40}$/.test(state.commit) || (state.port ?? 8787) !== port || !['building','prepared','configured','running'].includes(state.phase) ||
          state.deviceUuid !== undefined && !validUuid(state.deviceUuid)) {
        throw new KakaoError('CONFIG_INVALID', 'Existing installation needs review; bootstrap does not update another revision');
      }
      if (fs.existsSync(path.join(data, 'operator-paused'))) throw new KakaoError('POLICY_DENIED', 'Operator pause is active; setup will not resume it');
      if (state.commit !== commit) {
        // Only a clean, empty installation that has never stored credentials can refresh its build.
        // Keep the pending device identity; configured/running installations require a separate update flow.
        const dataStat = present(data) ? fs.lstatSync(data) : undefined;
        if (state.phase !== 'prepared' || present(h.unitFile) || present(path.join(app, '.env.local')) ||
            !dataStat || !dataStat.isDirectory() || dataStat.isSymbolicLink() || fs.readdirSync(data).length) {
          throw new KakaoError('CONFIG_INVALID', 'Existing account installation needs review; setup will not update it');
        }
        ownerPath(app, true);
        if (h.run('git', ['-C', app, 'rev-parse', 'HEAD']).trim() !== state.commit ||
            h.run('git', ['-C', app, 'status', '--porcelain']).trim() ||
            git('merge-base', state.commit, commit) !== state.commit) {
          throw new KakaoError('CONFIG_INVALID', 'Prepared checkout must be clean and an ancestor of published main');
        }
        h.log('아직 로그인하지 않은 설치 코드를 최신 origin/main으로 갱신합니다. 기존 기기 키는 유지합니다.');
        state = { ...state, commit, phase: 'building' }; writePrivate(stateFile, JSON.stringify(state));
      }
    } else {
      if (present(h.unitFile) || present(path.join(h.repo, '.env.local')) ||
          h.run('getent', ['passwd', service], true).trim() || await h.occupied()) {
        throw new KakaoError('WORKER_IN_USE', 'Existing service, credentials or endpoint found. Use the existing-daemon connection flow; no new login attempted.');
      }
      fs.mkdirSync(h.root, { mode: 0o755 });
      fs.chmodSync(h.root, 0o755); // A restrictive operator umask must not block the service from its home.
      state = { version: 1, commit, phase: 'building', port }; writePrivate(stateFile, JSON.stringify(state));
    }
    if (state.phase === 'building') {
      if (present(h.unitFile) || present(path.join(app, '.env.local'))) {
        throw new KakaoError('STORAGE_UNSAFE', 'Unexpected service or credentials during build; manual review required');
      }
      if (!h.run('getent', ['passwd', service], true).trim()) {
        h.run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', h.root, '--shell', '/usr/sbin/nologin', service]);
      }
      h.log('origin/main의 고정 커밋을 Git으로 설치하고 의존성과 protocol을 빌드합니다.');
      if (!fs.existsSync(app)) h.run('git', ['-c', `safe.directory=${h.repo}`, 'clone', '--depth', '1', '--no-local', '--no-checkout', '--', h.repo, app]);
      const appStat = fs.lstatSync(app), buildUid = Number(h.run('id', ['-u', service]).trim()), buildGid = Number(h.run('id', ['-g', service]).trim());
      if (!Number.isSafeInteger(buildUid) || buildUid <= 0 || !appStat.isDirectory() || appStat.isSymbolicLink() || (appStat.mode & 0o022) ||
          !Number.isSafeInteger(buildGid) || buildGid < 0 || appStat.uid !== process.getuid?.() && appStat.uid !== buildUid) {
        throw new KakaoError('STORAGE_UNSAFE', 'Unsafe installation checkout; no build executed');
      }
      h.run('git', ['-c', `safe.directory=${h.repo}`, '-C', app, 'fetch', '--no-tags', '--depth', '1', h.repo, commit]);
      h.run('git', ['-C', app, 'checkout', '--detach', commit]);
      h.run('chown', ['-R', `${service}:${service}`, app]);
      // The service home is root-owned: npm must not try to create ~/.npm there.
      const cache = path.join(h.root, 'build-cache'); fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      const cacheOwner = fs.lstatSync(cache).uid;
      if (cacheOwner !== buildUid && cacheOwner !== process.getuid?.()) throw new KakaoError('STORAGE_UNSAFE', 'Unexpected build cache owner');
      ownerPath(cache, true, cacheOwner); fs.chownSync(cache, buildUid, buildGid); fs.chmodSync(cache, 0o700);
      h.run('runuser', ['-u', service, '--', h.node, h.npm, '--prefix', app, '--cache', cache, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], false, app);
      h.run('runuser', ['-u', service, '--', h.node, path.join(app, 'node_modules/typescript/bin/tsc'), '-b', path.join(app, 'packages/protocol')], false, app);
      h.run('chown', ['-R', `root:${service}`, app]);
      h.run('chmod', ['-R', 'u=rwX,g=rX,o=', app]);
      fs.rmSync(cache, { recursive: true, force: true });
      state = { ...state, version: 1, commit, phase: 'prepared', port };
      writePrivate(stateFile, JSON.stringify(state));
    }
    ownerPath(app, true);
    if (h.run('git', ['-C', app, 'rev-parse', 'HEAD']).trim() !== commit || h.run('git', ['-C', app, 'status', '--porcelain']).trim()) {
      throw new KakaoError('CONFIG_INVALID', 'Installed Git checkout differs from the pinned revision; no account operation attempted');
    }
    const serviceUid = Number(h.run('id', ['-u', service]).trim()), serviceGid = Number(h.run('id', ['-g', service]).trim());
    if (!Number.isSafeInteger(serviceUid) || serviceUid <= 0 || !Number.isSafeInteger(serviceGid) || serviceGid < 0) {
      throw new KakaoError('CONFIG_INVALID', 'Cannot resolve the dedicated service identity');
    }
    const envFile = path.join(app, '.env.local');
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    const dataUid = fs.lstatSync(data).uid;
    if (dataUid !== serviceUid && dataUid !== process.getuid?.()) throw new KakaoError('STORAGE_UNSAFE', 'Data directory has an unexpected owner');
    ownerPath(data, true, dataUid);
    fs.chownSync(data, serviceUid, serviceGid); fs.chmodSync(data, 0o700);
    const persistState = () => writePrivate(stateFile, JSON.stringify(state));
    // Recover a crash after credentials reached disk but before the phase update. Never register again.
    if (state.phase === 'prepared' && fs.existsSync(envFile)) {
      ownerPath(envFile, false, serviceUid);
      if ((fs.statSync(envFile).mode & 0o077) || fs.statSync(envFile).size > 65536) {
        throw new KakaoError('STORAGE_UNSAFE', 'Existing credentials require review; no registration attempted');
      }
      state = { version: 1, commit, phase: 'configured', port }; persistState();
    }
    if (state.phase === 'prepared') {
      if (await h.occupied()) throw new KakaoError('WORKER_IN_USE', 'MCP endpoint is in use; no registration attempted');
      h.log('계정 정보를 입력하면 휴대폰 승인 로그인을 요청합니다. Ctrl+C로 취소할 수 있습니다. 기존 PC 카카오톡과 충돌할 수 있습니다. 비밀번호는 화면·명령 인자에 남기지 않습니다. 로그인 성공 후 자동 재로그인을 위한 서버 저장 여부를 선택할 수 있습니다.');
      const email = (await h.prompt('카카오 계정 이메일: ')).trim();
      let password = await h.prompt('카카오 계정 비밀번호: ', true);
      if (!email || !password || /[\r\n\0]/.test(email + password)) throw new KakaoError('INVALID_ARGUMENT', 'Account input is empty or invalid');
      state.deviceUuid ??= randomBytes(52).toString('base64'); persistState();
      let result: SignRegistrationResult;
      let loginData: { email: string; password: string } | undefined;
      try {
        result = await h.register(email, password, state.deviceUuid, false);
        if (result.status === -101) {
          h.log('다른 PC가 계정을 사용 중입니다. Enter로 기존 연결을 유지할 수 있습니다.');
          if (!await confirmSetup(h.prompt, '기존 PC를 로그아웃하고 이 서버로 연결할까요?')) {
            throw new KakaoError('PC_SESSION_CONFLICT', '기존 PC 연결을 유지했습니다. 계정 이전·서비스 시작을 하지 않습니다.');
          }
          result = await h.register(email, password, state.deviceUuid, true);
        }
        if (result.status === 0 && await confirmSetup(h.prompt, '자동 재로그인을 위해 이메일·비밀번호를 이 서버의 비공개 .env.local에 저장할까요? (강제 로그인 없음, 최대 하루 3회)')) {
          loginData = { email, password };
        }
      } catch (e) {
        if (e instanceof KakaoError && e.code === 'PC_SESSION_CONFLICT') throw e;
        throw new KakaoError('NETWORK', 'Account registration failed; credentials and upstream response were not logged', { retryable: false });
      } finally { password = ''; }
      if (result.failure) throw new KakaoError(result.failure === 'unsupported-method' ? 'NOT_IMPLEMENTED' : 'LOCO_STATUS', result.failure === 'unsupported-method' ? '이 계정의 인증 방식을 확인할 수 없습니다. 로그인 재시도를 멈췄습니다.' : '인증번호 응답 형식이 예상과 달라 중단했습니다. 서비스는 시작하지 않았습니다.');
      if (!Number.isSafeInteger(result.status)) throw new KakaoError('LOCO_STATUS', 'Malformed account response; no credentials were persisted and no service was started');
      if (result.status === -142) throw new KakaoError('APPROVAL_REQUIRED', '휴대폰 승인이 완료되지 않았습니다. 기기 키는 보존했습니다. 준비되면 마법사를 다시 실행하세요. 서비스는 시작하지 않았습니다.');
      if (result.status !== 0) throw new KakaoError(result.status === -101 ? 'PC_SESSION_CONFLICT' : 'LOCO_STATUS', `Account connection did not complete (status ${result.status}); check the account/phone approval before running setup again. No service was started.`);
      const values = { KAKAO_USER_ID: result.credentials?.userId, KAKAO_ACCESS_TOKEN: result.credentials?.accessToken,
        KAKAO_REGISTERED_DEVICE_UUID: result.deviceUuid, KAKAO_REFRESH_TOKEN: result.credentials?.refreshToken };
      if (!/^[1-9]\d{0,18}$/.test(values.KAKAO_USER_ID ?? '') || BigInt(values.KAKAO_USER_ID!) > 9223372036854775807n || !values.KAKAO_ACCESS_TOKEN || !validUuid(result.deviceUuid) || result.deviceUuid !== state.deviceUuid ||
          Object.values(values).some(v => v !== undefined && (typeof v !== 'string' || v.length > 8192 || /[\x00-\x1f\x7f]/.test(v)))) {
        throw new KakaoError('CONFIG_INVALID', 'Registration returned incomplete credentials; nothing was persisted');
      }
      const config = { ...values, KAKAO_DATA_DIR: data, KAKAO_AUDIT_LOG: path.join(data, 'audit.log'), KAKAO_MCP_LISTEN: listen,
        KAKAO_ENABLE_TOKEN_REFRESH: loginData ? '1' : '0',
        KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS: '3', KAKAO_EMAIL: loginData?.email, KAKAO_PASSWORD: loginData?.password,
        KAKAO_MCP_ALLOWED_UIDS: h.operatorUid !== undefined ? String(h.operatorUid) : undefined };
      writePrivate(envFile, Object.entries(config).filter(([,v]) => v !== undefined).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', serviceUid, serviceGid);
      loginData = undefined;
      state = { version: 1, commit, phase: 'configured', port }; persistState();
    }
    ownerPath(envFile, false, serviceUid);
    if ((fs.statSync(envFile).mode & 0o077) || fs.statSync(envFile).size > 65536) throw new KakaoError('STORAGE_UNSAFE', 'Credentials must be private to the service account');
    const saved = parseEnv(fs.readFileSync(envFile, 'utf8'));
    if (!/^[1-9]\d{0,18}$/.test(saved.KAKAO_USER_ID ?? '') || BigInt(saved.KAKAO_USER_ID) > 9223372036854775807n || !saved.KAKAO_ACCESS_TOKEN || !validUuid(saved.KAKAO_REGISTERED_DEVICE_UUID) ||
        saved.KAKAO_DATA_DIR !== data || saved.KAKAO_MCP_LISTEN !== listen) {
      throw new KakaoError('STORAGE_UNSAFE', 'Stored installation settings require review; no registration or start attempted');
    }
    if (present(h.unitFile)) {
      ownerPath(h.unitFile);
      if (fs.readFileSync(h.unitFile, 'utf8') !== serviceUnit(app, data, h.node, service)) {
        throw new KakaoError('WORKER_IN_USE', 'Existing service definition differs; it was not overwritten');
      }
      if (h.run('systemctl', ['is-active', unit], true).trim() === 'active') {
        if (!await h.healthy(saved.KAKAO_USER_ID)) throw new KakaoError('NOT_CONNECTED', 'Existing managed service is active but account health is unconfirmed; it was not restarted');
        h.log('기존 설치가 연결되어 있습니다. 재시작·재로그인하지 않습니다.'); return 'ready';
      }
    }
    if (await h.occupied()) throw new KakaoError('WORKER_IN_USE', 'Another process owns the MCP endpoint; it was not stopped');
    h.log('설치와 계정 설정이 준비되었습니다. 시작하면 데몬 하나가 계정에 연결합니다. 내용 조회·전송 방 허가는 아직 없습니다.');
    h.log(`시작할 버전: ${commit.slice(0, 12)}\n서비스 계정: ${service}\n코드: ${app}\n계정 데이터: ${data}\nMCP: ${listen}, assistant/rooms. 공개 포트·자동 답장은 켜지 않습니다.`);
    if (!await confirmSetup(h.prompt, '서비스를 등록하고 시작할까요?', true)) return 'configured';
    ownerPath(path.dirname(h.unitFile), true);
    if (present(h.unitFile)) ownerPath(h.unitFile);
    writePrivate(h.unitFile, serviceUnit(app, data, h.node, service)); fs.chmodSync(h.unitFile, 0o644);
    h.run('systemctl', ['daemon-reload']); h.run('systemctl', ['enable', '--now', unit]);
    let connected = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await h.healthy(saved.KAKAO_USER_ID)) { connected = true; break; }
      if (attempt < 9) await h.wait(1000);
    }
    if (!connected) throw new KakaoError('NOT_CONNECTED', 'Service was started but account health is not confirmed. Inspect systemctl/journal; setup will not retry login or restart it.');
    state = { version: 1, commit, phase: 'running', port }; persistState();
    const deployLog = path.join(h.root, 'deploys.log');
    if (present(deployLog)) ownerPath(deployLog);
    const logFd = fs.openSync(deployLog, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(logFd, `${new Date().toISOString()} human ${commit} ${h.reason}\n`); fs.fsyncSync(logFd); }
    finally { fs.closeSync(logFd); }
    h.log('계정 연결 상태 확인. 다음으로 AI의 MCP 연결 설정을 만드세요.');
    return 'ready';
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

function validUuid(value: string): boolean {
  return typeof value === 'string' && value.length === 72 && Buffer.from(value, 'base64').length === 52 && Buffer.from(value, 'base64').toString('base64') === value;
}

function protectedExecutable(file: string): string {
  let resolved = fs.realpathSync(file), current = resolved;
  for (;;) {
    const stat = fs.statSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022)) throw new KakaoError('CONFIG_INVALID', 'Install requires a system-owned Node/npm, outside user-writable directories');
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return resolved;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const main = async () => {
    if (!(process.argv.length === 4 || process.argv.length === 6 && process.argv[4] === '--port') || process.argv[2] !== '--via-deploy' || process.platform !== 'linux' || process.getuid?.() !== 0 || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new KakaoError('APPROVAL_REQUIRED', 'Run the Linux installation wizard from a human terminal with sudo scripts/install.sh bootstrap');
    }
    const port = installPort(process.argv[5] ?? '8787');
    const node = protectedExecutable(process.execPath), npm = protectedExecutable(path.join(path.dirname(node), 'npm'));
    const run = (program: string, args: string[], allowFailure = false, cwd?: string) => {
      const command = ['/usr/bin', '/usr/sbin', '/bin', '/sbin'].map(dir => path.join(dir, program)).find(p => fs.existsSync(p));
      if (!command) throw new KakaoError('CONFIG_INVALID', `Install requires ${path.basename(program)}`);
      const r = spawnSync(protectedExecutable(command), args, { encoding: 'utf8', cwd });
      if (r.error || r.status !== 0 && !allowFailure) throw new KakaoError('CONFIG_INVALID', `${path.basename(program)} did not complete (exit ${r.status ?? 'spawn failure'}). Review installation prerequisites; no automatic retry.`, { cause: r.error });
      return r.status === 0 ? r.stdout : '';
    };
    const occupied = () => new Promise<boolean>(resolve => {
      const s = net.connect(port, '127.0.0.1'); s.setTimeout(1000);
      const finish = (v: boolean) => { s.destroy(); resolve(v); };
      s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.once('timeout', () => finish(true));
    });
    const healthy = (expectedUserId: string) => new Promise<boolean>(resolve => {
      const s = net.connect(port, '127.0.0.1'); s.setTimeout(2000);
      const finish = (v: boolean) => { s.destroy(); resolve(v); };
      s.once('connect', () => { s.setTimeout(0); probe(s, 3000).then(r => finish(r.healthy && r.userId === expectedUserId)); });
      s.once('error', () => finish(false)); s.once('timeout', () => finish(false));
    });
    const outcome = await bootstrapLocal({ repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), root: '/var/lib/kakao-max',
      unitFile: '/etc/systemd/system/kakao-max.service', node, npm, run, prompt: terminalPrompt, log: s => process.stderr.write(s + '\n'), occupied, healthy,
      reason: process.argv[3], port,
      operatorUid: /^[1-9]\d{0,9}$/.test(process.env.SUDO_UID ?? '') ? Number(process.env.SUDO_UID) : undefined,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      register: (email, password, uuid, takeover) => new KakaoDeviceRegistration('kakao-max Linux', {}, uuid).register(email, password, {
        confirmTakeover: takeover,
        // Closed stage/status diagnostics only: never print raw responses or account input.
        onResponse: trace => {
          if (trace.status !== undefined && trace.status !== 0 && trace.status !== -142 && !(trace.stage === 'register_device' && trace.status === -100)) {
            process.stderr.write(`[setup] account stage=${trace.stage} status=${trace.status} httpStatus=${trace.httpStatus ?? 'unknown'} signRegistration=${trace.signRegistration ?? 'unknown'}\n`);
          }
        },
        onPasscode: info => process.stderr.write(`휴대폰 카카오톡의 PC 기기 인증 화면에 아래 인증번호를 입력해 주세요.\n인증번호: ${info.passcode} (유효 시간 ${Math.floor(info.remainingSeconds)}초)\n`),
        onAwaitingApproval: () => process.stderr.write('휴대폰 카카오톡에서 새 기기 로그인을 승인해 주세요.\n') }) });
    if (outcome !== 'ready') {
      process.stderr.write(outcome === 'configured' ? '계정 설정만 보존했습니다. 서비스를 시작하지 않았습니다.\n' : '설치를 취소했습니다. 준비된 파일이 있으면 다음 실행에서 이어갑니다.\n');
      process.exitCode = outcome === 'configured' ? 3 : 4;
    }
  };
  main().catch(e => { process.stderr.write(`[setup] ${e instanceof KakaoError ? e.message : 'Installation stopped; review existing state before retrying'}\n`); process.exitCode = 1; });
}
