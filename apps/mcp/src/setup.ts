#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KakaoError, writeOwnerOnlyJson, isOwnerOnly, writeEnvKeys, readEnvFile, findEnvFile, AGENT_MODES, TRUST_RISK_NOTICE, type AgentMode, isMainModule, installRoot, packagedEntry, programArgs, setupCommand, type ProgramName } from '@kakao-max/core';
import { confirmSetup, terminalPrompt, type SetupPrompt } from './setup-prompts.ts';
import { installPort } from './setup-system.ts';
import { diagnoseConnection } from './connection-doctor.ts';
import { parseListenSpec, validateListenSpec } from './socket-transport.ts';

export interface McpConnectionConfig { mcpServers: { 'kakao-max': { command: string; args: string[] } } }
const ROOT = installRoot();

export function resolveClientConfigFile(homedir = os.homedir()): { file: string; isFallback: boolean } {
  const newPath = path.join(homedir, '.config/kakao-max/mcp.json');
  const oldPath = path.join(homedir, '.config/kakaotalk-mcp/mcp.json');
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    return { file: oldPath, isFallback: true };
  }
  return { file: newPath, isFallback: false };
}

/** SSH forwards stdio directly to loopback. It never runs a remote shell or starts a daemon. */
export function connectionConfig(opts: { ssh?: string; listen?: string; repo?: string; node?: string; packaged?: boolean }): McpConnectionConfig {
  const listen = opts.listen ?? '127.0.0.1:8787', spec = parseListenSpec(listen);
  if (spec.path && opts.ssh) throw new KakaoError('INVALID_ARGUMENT', 'SSH setup uses the daemon loopback TCP endpoint');
  if (!spec.path) validateListenSpec(spec);
  if (opts.ssh && (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(opts.ssh) || opts.ssh.length > 253)) {
    throw new KakaoError('INVALID_ARGUMENT', 'Use an SSH host alias or user@host, without flags or shell commands');
  }
  return { mcpServers: { 'kakao-max': { command: opts.node ?? process.execPath,
    args: [...programArgs('connect', { root: opts.repo ?? ROOT, packaged: opts.packaged }), '--resilient', '--listen', listen,
      ...(opts.ssh ? ['--ssh', opts.ssh] : [])] } } };
}

export async function saveConnection(file: string, config: McpConnectionConfig, prompt: SetupPrompt): Promise<void> {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink() || !isOwnerOnly(dir)) {
    throw new KakaoError('CONFIG_INVALID', 'Connection settings require an owner-only directory');
  }
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwnerOnly(stat)) {
      throw new KakaoError('CONFIG_INVALID', 'Existing connection settings are unsafe');
    }
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify(config)) return;
    if (!await confirmSetup(prompt, '기존 MCP 연결 설정을 덮어쓸까요?')) {
      throw new KakaoError('POLICY_DENIED', 'Existing connection settings were preserved');
    }
  }
  writeOwnerOnlyJson(file, config);
}

/**
 * Operator-only: record the agent mode in the daemon's settings file. trust needs `acceptRisk`, so an AI
 * running setup for someone has to show them the risk notice and come back with their answer.
 * No MCP tool calls this; the daemon reads the mode at start.
 */
export function setAgentMode(opts: { envPath: string; mode: string; acceptRisk: boolean; log(text: string): void }): AgentMode {
  if (!(AGENT_MODES as readonly string[]).includes(opts.mode)) throw new KakaoError('INVALID_ARGUMENT', `Use --mode ${AGENT_MODES.join(' or ')}`);
  const mode = opts.mode as AgentMode;
  if (mode === 'trust' && !opts.acceptRisk) {
    opts.log(TRUST_RISK_NOTICE);
    throw new KakaoError('POLICY_DENIED', 'trust was not set. Show the notice above to the person; if they accept, run again with --accept-risk.');
  }
  const current = readEnvFile(opts.envPath);
  if (mode === 'ask' && ['1', 'true', 'yes', 'on'].includes((current.KAKAO_VAULT_AUTO_SAVE ?? '').toLowerCase())) {
    throw new KakaoError('CONFIG_INVALID', 'KAKAO_VAULT_AUTO_SAVE works only in trust. Delete that line first, then set ask.');
  }
  writeEnvKeys(opts.envPath, { KAKAO_AGENT_MODE: mode });
  opts.log(`KAKAO_AGENT_MODE=${mode} 저장: ${opts.envPath}. 데몬을 다시 시작해야 적용됩니다.`);
  return mode;
}

export async function runSetup(deps: {
  prompt: SetupPrompt; log(text: string): void; output(text: string): void;
  configFile: string; repo: string; platform: string; install(port?: number): boolean;
  diagnose?: typeof diagnoseConnection;
}): Promise<void> {
  deps.log('카카오톡 MCP: 기존 데몬 연결 또는 새 Linux 설치. AI 연결을 열 때 새 계정 세션을 만들지 않습니다.');
  let installedPort: number | undefined;
  const choice = await deps.prompt('기존 데몬 연결은 1, 새 Linux 서버 설치는 2 (취소: Enter): ');
  if (choice === '2') {
    if (deps.platform !== 'linux') throw new KakaoError('CONFIG_INVALID', '새 서버 설치는 Linux/systemd에서 실행하세요. 기존 서버 연결은 이 컴퓨터에서도 가능합니다.');
    deps.log('전용 서비스 계정에 설치합니다. 기존 PC 카카오톡과 활성 세션이 충돌할 수 있습니다. 다른 PC를 자동 로그아웃하지 않습니다.');
    if (!await confirmSetup(deps.prompt, '이 서버에 새로 설치할까요?', true)) return;
    installedPort = installPort(((await deps.prompt('설치할 MCP 포트 (Enter: 8787): ')) ?? '').trim() || '8787');
    if (!deps.install(installedPort)) return;
  } else if (choice !== '1') return;
  const ssh = (await deps.prompt('내 AI에서 접속할 SSH 대상(user@host 또는 SSH 별칭), 같은 컴퓨터면 Enter: ')).trim();
  const defaultListen = `127.0.0.1:${installedPort ?? 8787}`;
  const listen = ((await deps.prompt(`서버 MCP 주소 (Enter: ${defaultListen}, 다른 포트면 127.0.0.1:포트): `)) ?? '').trim() || defaultListen;
  const config = connectionConfig({ ssh: ssh || undefined, listen, repo: deps.repo });
  const resolved = resolveClientConfigFile();
  if (resolved.isFallback && resolved.file === deps.configFile) {
    deps.log(`기존 설정 파일 사용: ${deps.configFile}. kakao-max 기본 경로로 옮기려면 디렉터리를 ~/.config/kakao-max 로 이동하세요.`);
  }
  await saveConnection(deps.configFile, config, deps.prompt);
  deps.log(`연결 설정 저장: ${deps.configFile}. AI의 MCP 설정에 등록하세요. 기존 설정 파일은 자동 편집하지 않습니다.`);
  deps.output(JSON.stringify(config, null, 2));
  if (deps.diagnose) {
    const result = await deps.diagnose({ listen, ssh: ssh || undefined });
    deps.log(result.connected ? '서버 연결 정상. AI에 방 이름과 원하는 작업을 말하면 됩니다. 방별 권한은 필요한 시점에 별도로 요청합니다.' : `설정은 저장했지만 연결 확인이 필요합니다. ${result.nextAction}`);
  }
  deps.log(`연결 확인: ${setupCommand(`--doctor --listen ${listen}${ssh ? ' --ssh ' + ssh : ''}`)}. 연결이 안 되면 이 진단부터 실행하세요.`);
}

/** Run another program of this install as root through sudo, in the person's terminal. */
function sudoProgram(name: ProgramName, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('sudo', ['--', process.execPath, ...programArgs(name), ...args], { cwd: ROOT, stdio: 'inherit' });
}

if (isMainModule(import.meta.url, 'setup')) {
  const args = process.argv.slice(2), packaged = packagedEntry() !== undefined;
  const main = async () => {
    if (args[0] === '--doctor') {
      const opts: { listen: string; ssh?: string } = { listen: '127.0.0.1:8787' };
      for (let i = 1; i < args.length; i += 2) {
        if (!['--listen', '--ssh'].includes(args[i]) || !args[i + 1]) throw new KakaoError('INVALID_ARGUMENT', 'Use --doctor [--listen endpoint] [--ssh host]');
        if (args[i] === '--listen') opts.listen = args[i + 1]; else opts.ssh = args[i + 1];
      }
      const result = await diagnoseConnection(opts);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.connected ? 0 : 1; return;
    }
    if ((args[0] === '--repair' || args[0] === '--update') && args.length === 1) {
      if (process.platform !== 'linux') throw new KakaoError('CONFIG_INVALID', `Run ${args[0]} on the Linux server; --doctor also works from your AI computer.`);
      if (packaged) {
        // The package's own release is what gets installed: upgrade the package first, then run --update.
        const result = sudoProgram('update-managed', ['--via-deploy', 'release', args[0] === '--update' ? 'package update' : 'interactive managed authentication repair', ...(args[0] === '--repair' ? ['--repair'] : [])]);
        if (result.status !== 0) throw new KakaoError(args[0] === '--repair' ? 'AUTH_EXPIRED' : 'CONFIG_INVALID', `${args[0] === '--repair' ? 'Repair' : 'Update'} stopped. Follow the terminal message; no automatic takeover or registration.`);
        return;
      }
      if (args[0] === '--update') throw new KakaoError('INVALID_ARGUMENT', 'A source checkout is updated by its operator deploy flow; --update is for package installs.');
      const fetched = spawnSync('git', ['fetch', '--no-tags', 'origin', 'main'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      if (fetched.status !== 0) throw new KakaoError('CONFIG_INVALID', 'Update Git access first; no login was attempted.');
      const repair = spawnSync('sudo', ['--', path.join(ROOT, 'scripts/install.sh'), 'repair'], { cwd: ROOT, stdio: 'inherit' });
      if (repair.status !== 0) throw new KakaoError('AUTH_EXPIRED', 'Repair stopped. Follow the terminal message; no automatic takeover or registration.');
      return;
    }
    if (args[0] === '--mode') {
      const rest = args.slice(2), opts = { envPath: findEnvFile(), acceptRisk: false };
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--accept-risk' && !opts.acceptRisk) opts.acceptRisk = true;
        else if (rest[i] === '--env' && rest[i + 1]) opts.envPath = path.resolve(rest[++i]);
        else throw new KakaoError('INVALID_ARGUMENT', 'Use --mode ask|trust [--accept-risk] [--env path/to/.env.local]');
      }
      setAgentMode({ ...opts, mode: args[1] ?? '', log: s => process.stderr.write(s + '\n') });
      return;
    }
    if (args[0] === '--config') {
      const opts: { ssh?: string; listen?: string } = {};
      for (let i = 1; i < args.length; i += 2) {
        const key = args[i] === '--ssh' ? 'ssh' : args[i] === '--listen' ? 'listen' : undefined;
        if (!key || !args[i + 1] || opts[key] !== undefined) throw new KakaoError('INVALID_ARGUMENT', 'Use --config [--ssh user@host] [--listen loopback:port]');
        opts[key] = args[i + 1];
      }
      process.stdout.write(JSON.stringify(connectionConfig(opts), null, 2) + '\n'); return;
    }
    if (args.length) throw new KakaoError('INVALID_ARGUMENT', `Usage: ${setupCommand('[--config [--ssh user@host] [--listen loopback:port]] | --doctor | --repair | --update | --mode ask|trust [--accept-risk] [--env path]')}`);
    const clientConfig = resolveClientConfigFile();
    await runSetup({ prompt: terminalPrompt, log: s => process.stderr.write(s + '\n'), output: s => process.stdout.write(s + '\n'),
      diagnose: diagnoseConnection, repo: ROOT, platform: process.platform, configFile: clientConfig.file,
      install: port => {
        if (packaged) {
          const result = sudoProgram('setup-system', ['--via-deploy', 'self-hosted MCP first install', '--port', String(port ?? 8787)]);
          if (result.status === 3 || result.status === 4) return false; // Settings-only or intentional cancellation.
          if (result.error || result.status !== 0) throw new KakaoError('CONFIG_INVALID', 'Installation did not complete; review the installer message. No automatic retry.');
          return true;
        }
        // Fetch as the invoking user, before sudo, so root does not take ownership of their .git files.
        const fetched = spawnSync('git', ['fetch', '--no-tags', 'origin', 'main'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
        if (fetched.error || fetched.status !== 0) throw new KakaoError('CONFIG_INVALID', 'Could not refresh origin/main. Update Git access before installing; no login attempted.');
        const result = spawnSync('sudo', ['--', path.join(ROOT, 'scripts/install.sh'), 'bootstrap', '--port', String(port ?? 8787)],
          { cwd: ROOT, stdio: 'inherit' });
        if (result.status === 3 || result.status === 4) return false; // Settings-only or intentional cancellation.
        if (result.error || result.status !== 0) throw new KakaoError('CONFIG_INVALID', 'Installation did not complete; review the installer message. No automatic retry.');
        return true;
      } });
  };
  main().catch(e => { process.stderr.write(`[setup] ${e instanceof KakaoError ? e.message : 'Setup failed; existing settings were preserved'}\n`); process.exitCode = 1; });
}
