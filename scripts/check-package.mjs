#!/usr/bin/env node
// Pack the package, install the tarball into a temporary prefix and run its commands the way a person would.
// Never contacts Kakao: the daemon is started with a refused transport setting, so it stops before any session.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-max-package-'));
const failures = [];
const check = (ok, label) => { process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`); if (!ok) failures.push(label); };
// A clean HOME and working directory: no real settings, credentials or account data are read.
const home = path.join(temp, 'home'), work = path.join(temp, 'work');
fs.mkdirSync(home); fs.mkdirSync(work);
const env = { ...process.env, HOME: home, USERPROFILE: home, KAKAO_DATA_DIR: path.join(home, 'data'), npm_config_update_notifier: 'false' };
for (const key of Object.keys(env)) if (key.startsWith('KAKAO_') && key !== 'KAKAO_DATA_DIR') delete env[key];
// Windows runs npm and the .cmd command shims through the shell, which does not quote arguments itself.
const quote = value => win && /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const run = (command, args, opts = {}) => spawnSync(quote(command), args.map(quote), { encoding: 'utf8', cwd: work, env, shell: win, timeout: 120_000, ...opts });

try {
  const packed = run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root });
  check(packed.status === 0, 'npm pack builds and packs');
  if (packed.status !== 0) throw new Error(packed.stderr);
  const [info] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
  const files = info.files.map(f => f.path);
  check(info.name === 'kakao-max', `package name is kakao-max (${info.version})`);
  check(files.every(f => ['package.json', 'README.md', 'LICENSE'].includes(f) || f.startsWith('dist/')), 'tarball holds only package.json, README, LICENSE and dist/');
  check(!files.some(f => f.endsWith('.ts')) && files.includes('dist/THIRD-PARTY-NOTICES.txt'), 'no TypeScript sources; bundled-dependency notices included');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0, 'no runtime dependencies');

  const prefix = path.join(temp, 'install');
  const installed = run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--offline', path.join(temp, info.filename)]);
  check(installed.status === 0, 'tarball installs offline into a fresh prefix');
  if (installed.status !== 0) throw new Error(installed.stderr);
  const pkg = path.join(prefix, 'node_modules', 'kakao-max');
  const bin = name => path.join(prefix, 'node_modules', '.bin', win ? `${name}.cmd` : name);
  for (const name of ['kakao-max', 'kakao-max-mcp', 'kakao-max-web']) check(fs.existsSync(bin(name)), `command ${name} is linked`);

  const help = run(bin('kakao-max'), ['help']);
  check(help.status === 0 && help.stdout.includes('kakao setup'), 'kakao-max help runs');
  const version = run(bin('kakao-max'), ['--version']);
  check(version.status === 0 && version.stdout.trim() === info.version, `kakao-max --version prints ${info.version}`);

  const config = run(bin('kakao-max'), ['setup', '--config', '--listen', '127.0.0.1:8787']);
  let args = [];
  try { args = JSON.parse(config.stdout).mcpServers['kakao-max'].args; } catch { /* reported below */ }
  check(config.status === 0 && args[0] === path.join(fs.realpathSync(pkg), 'dist', 'connect.mjs') && fs.existsSync(args[0]) && !args.includes('--experimental-strip-types'),
    'kakao-max setup --config points the AI client at the installed connector');

  // Without a registered device the daemon stops before opening any session.
  const daemon = run(bin('kakao-max-mcp'), [], { env: { ...env, KAKAO_MCP_LISTEN: '0.0.0.0:8787' }, timeout: 30_000 });
  check(daemon.status !== 0 && daemon.stderr.includes('Run kakao-max setup to register this device') && !/SyntaxError|Cannot find|ERR_MODULE/.test(daemon.stderr),
    'kakao-max-mcp loads and stops without a registered device');

  const doctor = run(bin('kakao-max'), ['setup', '--doctor', '--listen', '127.0.0.1:9']);
  check(doctor.status === 1 && doctor.stdout.includes('kakao-max setup --repair'), 'kakao-max setup --doctor reports an unreachable daemon with package commands');

  const web = await new Promise(resolve => {
    // Started with node directly so that stopping it stops the server, not only a Windows shell around it.
    const child = spawn(process.execPath, [path.join(pkg, 'dist', 'web.mjs')], { cwd: work, env: { ...env, PORT: '0', MCP_PORT: '9' } });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false }); }, 30_000);
    child.stdout.on('data', async chunk => {
      out += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/launch\?t=/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      try {
        const page = await fetch(`http://127.0.0.1:${m[1]}/`);
        const launch = await fetch(`http://127.0.0.1:${m[1]}/launch?t=wrong`, { redirect: 'manual' });
        resolve({ ok: page.status === 401 && launch.status === 403 });
      } catch { resolve({ ok: false }); }
      finally { child.kill(); }
    });
  });
  check(web.ok, 'kakao-max-web serves its page and refuses requests without the launch link');
} catch (error) {
  failures.push(error instanceof Error ? error.message.split('\n')[0] : 'unexpected failure');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (failures.length) { process.stderr.write(`Package check failed: ${failures.length} problem(s)\n`); process.exitCode = 1; }
else process.stdout.write('Package check passed\n');
