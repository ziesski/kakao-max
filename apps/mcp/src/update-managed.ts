// Update or repair only a managed daemon, via scripts/install.sh repair or the operator deploy script. Never register a device or force login.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { KakaoError, parseAllowedUids, removedSettingsIn, isMainModule, installRoot, packagedEntry } from '@kakao-max/core';
import { parseEnv } from '../../../packages/core/src/env-file.ts';
import { configureManagedLogin, readManagedEnv } from './managed-login.ts';
import { terminalPrompt } from './setup-prompts.ts';
import { serviceUnit, legacyServiceUnit, installPort, protectedRelease } from './setup-system.ts';
import { installRelease, releaseDigest, releaseLabel, RELEASE_DIGEST, RELEASE_VERSION, type Release } from './release.ts';
import { probe } from './healthcheck.ts';

const DEFAULT_SERVICE = 'kakao-max';
const LEGACY_SERVICE = 'kakaotalk-mcp';
const LEGACY_ROOT = '/var/lib/kakaotalk-mcp';
const LEGACY_UNIT = '/etc/systemd/system/kakaotalk-mcp.service';
// Settings a migration rewrites to the new root; every other line of .env.local must stay byte-identical.
const MOVED_KEYS = ['KAKAO_DATA_DIR', 'KAKAO_AUDIT_LOG'];

export interface UpdateHost {
  repo: string; root: string; unitFile: string; node: string; npm: string; target: string; reason: string;
  recover?: boolean;
  /** Update a package install to this release; `target` is then the literal `release`. */
  release?: Release;
  service?: string;
  legacyRoot?: string;
  legacyUnitFile?: string;
  legacyService?: string;
  configureLogin?: (envFile: string, dataDir: string, uid: number) => Promise<void>;
  run(program: string, args: string[], allowFailure?: boolean, cwd?: string): string;
  healthy(expectedUserId: string, port: number): Promise<boolean>; wait(): Promise<void>;
}
function protectedPath(file: string, directory: boolean, uid = process.getuid!()): void {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== uid || (s.mode & 0o022)) {
    throw new KakaoError('STORAGE_UNSAFE', 'Managed update path needs review');
  }
}
function manifest(file: string, state: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export async function updateManaged(h: UpdateHost): Promise<void> {
  const pkg = h.release, layout = pkg ? 'package' : 'source';
  if (!(pkg ? h.target === 'release' && RELEASE_VERSION.test(pkg.version) && RELEASE_DIGEST.test(pkg.digest) : /^[a-f0-9]{40}$/.test(h.target)) || !h.reason.trim() || h.reason.length > 256 || /[\x00-\x1f\x7f]/.test(h.reason)) throw new KakaoError('CONFIG_INVALID', 'Invalid managed update request');
  const service = h.service ?? DEFAULT_SERVICE;
  // Only the CLI names the host's legacy install; an injected host without legacy paths never migrates.
  const legacyRoot = h.legacyRoot ?? '';
  const legacyUnit = h.legacyUnitFile ?? '';
  const legacyService = h.legacyService ?? LEGACY_SERVICE;

  const targetRootExists = fs.existsSync(h.root);
  const legacyRootExists = legacyRoot !== '' && fs.existsSync(legacyRoot);
  const targetUnitExists = fs.existsSync(h.unitFile);
  const legacyUnitExists = legacyUnit !== '' && fs.existsSync(legacyUnit);

  if ((legacyRootExists && targetRootExists) || (legacyUnitExists && targetUnitExists)) {
    throw new KakaoError('CONFIG_INVALID', `Inconsistent managed install state: both legacy (${legacyService}) and target (${service}) artifacts exist. Inspect ${path.dirname(h.root)} and ${path.dirname(h.unitFile)} manually; nothing was stopped`);
  }

  const isMigration = legacyRootExists && !targetRootExists;
  if (isMigration && pkg) throw new KakaoError('CONFIG_INVALID', `The ${legacyService} installation came from a source checkout; migrate it from that checkout. Nothing was stopped`);
  const activeRoot = isMigration ? legacyRoot : h.root;
  const activeUnit = isMigration ? legacyUnit : h.unitFile;
  const activeService = isMigration ? legacyService : service;

  if (isMigration && !legacyUnitExists) {
    throw new KakaoError('CONFIG_INVALID', `Legacy managed unit ${legacyUnit} missing; nothing was stopped`);
  }

  protectedPath(path.dirname(activeRoot), true); protectedPath(activeRoot, true);
  const lock = `${activeRoot}.install-lock`;
  const targetLock = `${h.root}.install-lock`;
  if (isMigration && fs.existsSync(targetLock)) {
    throw new KakaoError('WORKER_IN_USE', 'Target managed installation is locked; inspect before retrying');
  }

  let fd: number;
  let targetFd: number | undefined;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new KakaoError('WORKER_IN_USE', 'Managed installation is locked; inspect before retrying'); }

  try {
    fs.writeSync(fd, `${process.pid}\n`); fs.fsyncSync(fd);
    let app = path.join(activeRoot, 'app'), data = path.join(activeRoot, 'data'), stateFile = path.join(activeRoot, 'install-state.json'), env = path.join(app, '.env.local');
    protectedPath(stateFile, false); protectedPath(app, true); protectedPath(activeUnit, false);
    if ((fs.statSync(stateFile).mode & 0o077) || fs.statSync(stateFile).size > 4096) throw new KakaoError('STORAGE_UNSAFE', 'Unsafe install manifest');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const port = installPort(String(state.port));
    if (pkg ? state.version === 1 : state.version === 2) {
      throw new KakaoError('CONFIG_INVALID', pkg ? 'This installation was set up from a source checkout; update it from that checkout. Nothing was stopped'
        : 'This installation was set up from the kakao-max package; update it with kakao-max setup --update. Nothing was stopped');
    }
    const validPin = pkg ? RELEASE_VERSION.test(state.release) && RELEASE_DIGEST.test(state.digest) : /^[a-f0-9]{40}$/.test(state.commit);
    // An update records the pin it is installing before it touches the app; the marker stays while the result is unconfirmed.
    const pending: string | undefined = typeof state.pendingUpdate === 'string' && (pkg ? RELEASE_DIGEST : /^[a-f0-9]{40}$/).test(state.pendingUpdate) ? state.pendingUpdate : undefined;
    if (state.pendingUpdate !== undefined && !pending) throw new KakaoError('CONFIG_INVALID', 'Invalid pending update in the install manifest; nothing was stopped');
    const base = { ...state }; delete base.pendingUpdate;
    // The commands that actually resume a stopped managed install, named in every message that leaves it stopped.
    const recoverCommand = pkg ? 'kakao-max setup --repair'
      : `sudo node --experimental-strip-types apps/mcp/src/update-managed.ts --via-deploy ${h.target} "<reason>" --recover (from the clean published checkout)`;
    const repairCommand = pkg ? 'kakao-max setup --repair' : 'npm run setup -- --repair';
    const pinLabel = (release: string | undefined, pin: string) => pkg && release ? releaseLabel(release, pin) : pin.slice(0, 12);
    if (pending && !h.recover) throw new KakaoError('CONFIG_INVALID', `A previous update did not finish and the service may be stopped. Run: ${recoverCommand}. Nothing was stopped`);
    if (![1, 2].includes(state.version) || (state.phase !== 'running' && !(h.recover && state.phase === 'configured')) || !validPin || state.deviceUuid !== undefined) throw new KakaoError('CONFIG_INVALID', 'Managed update requires running state, or explicit recovery of a configured installation');
    const uid = Number(h.run('id', ['-u', activeService]).trim()), gid = Number(h.run('id', ['-g', activeService]).trim());
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new KakaoError('CONFIG_INVALID', 'Invalid service identity');
    protectedPath(env, false, uid); protectedPath(data, true, uid);
    if ((fs.statSync(env).mode & 0o077) || fs.statSync(env).size > 65536 || fs.existsSync(path.join(data, 'operator-paused'))) throw new KakaoError('POLICY_DENIED', 'Private credentials or operator pause require review');
    let saved = readManagedEnv(env, !!h.configureLogin).values;
    // The new daemon refuses removed settings; say so now instead of stopping a working daemon for a start that fails.
    const retired = removedSettingsIn(saved);
    if (retired.length) throw new KakaoError('CONFIG_INVALID', `Settings file still has removed keys (${retired.join(', ')}); delete those lines from ${env}, then update again. Nothing was stopped`);
    // New daemons serve MCP TCP only to allowed OS users; without the setting only root and the service user could connect.
    if (saved.KAKAO_MCP_ALLOWED_UIDS !== undefined) parseAllowedUids(saved.KAKAO_MCP_ALLOWED_UIDS);
    else throw new KakaoError('CONFIG_INVALID', `Add KAKAO_MCP_ALLOWED_UIDS=<uid of the SSH user your MCP client connects as> to ${env}, then update again. Nothing was stopped`);

    const expectedUnit = isMigration
      ? legacyServiceUnit(app, data, h.node, activeService)
      : serviceUnit(app, data, h.node, activeService, undefined, layout);
    if (saved.KAKAO_DATA_DIR !== data || saved.KAKAO_MCP_LISTEN !== `127.0.0.1:${port}` || !/^[1-9]\d{0,18}$/.test(saved.KAKAO_USER_ID ?? '') ||
        fs.readFileSync(activeUnit, 'utf8') !== expectedUnit) throw new KakaoError('CONFIG_INVALID', 'Managed settings differ; nothing was restarted');

    if (isMigration) {
      if (fs.existsSync(h.root)) throw new KakaoError('CONFIG_INVALID', `Target root ${h.root} already exists; nothing was stopped`);
      if (fs.existsSync(h.unitFile)) throw new KakaoError('CONFIG_INVALID', `Target unit ${h.unitFile} already exists; nothing was stopped`);
      const targetUserCheck = h.run('id', ['-u', service], true).trim();
      if (targetUserCheck && /^\d+$/.test(targetUserCheck)) throw new KakaoError('CONFIG_INVALID', `Target user ${service} already exists; nothing was stopped`);
      const targetGroupCheck = h.run('getent', ['group', service], true).trim();
      if (targetGroupCheck) throw new KakaoError('CONFIG_INVALID', `Target group ${service} already exists; nothing was stopped`);
      // Setup writes the audit log into the data dir, so it moves with it. Any other setting naming the old root would break.
      if (saved.KAKAO_AUDIT_LOG !== undefined && saved.KAKAO_AUDIT_LOG !== path.join(data, 'audit.log')) {
        throw new KakaoError('CONFIG_INVALID', `KAKAO_AUDIT_LOG is not ${path.join(data, 'audit.log')}; set it there or remove it, then update again. Nothing was stopped`);
      }
      const stale = Object.entries(saved).filter(([k, v]) => !MOVED_KEYS.includes(k) && v?.includes(legacyRoot)).map(([k]) => k);
      if (stale.length) throw new KakaoError('CONFIG_INVALID', `Settings name the old root ${legacyRoot}: ${stale.join(', ')}. Change them, then update again. Nothing was stopped`);
    }

    const digest = () => createHash('sha256').update(fs.readFileSync(env)).digest('hex');
    const stripMovedPaths = (txt: string) => txt.split('\n').filter(l => !MOVED_KEYS.some(k => l.startsWith(`${k}=`))).join('\n');

    const git = (repo: string, ...args: string[]) => h.run('git', ['--no-optional-locks', '-c', `safe.directory=${h.repo}`, '-C', repo, ...args]).trim();
    const digestOf = (dir: string) => { try { return releaseDigest(dir); } catch { return ''; } };
    const rollbackDir = path.join(activeRoot, 'rollback');
    // After a failed update the app may hold the attempted pin (or, for a package, a partial copy); only explicit recovery accepts that.
    const resumable = !!(h.recover && pending);
    if (pkg) {
      if (digestOf(app) !== state.digest && !resumable) throw new KakaoError('CONFIG_INVALID', 'Installed files differ from the recorded release; nothing was stopped');
    } else if (git(h.repo, 'rev-parse', 'HEAD') !== h.target || git(h.repo, 'rev-parse', 'origin/main') !== h.target || git(h.repo, 'status', '--porcelain') ||
        ![state.commit, ...(resumable ? [pending] : [])].includes(git(app, 'rev-parse', 'HEAD')) || git(app, 'status', '--porcelain') || git(h.repo, 'merge-base', state.commit, h.target) !== state.commit) {
      throw new KakaoError('CONFIG_INVALID', 'Update requires clean published main and its managed ancestor');
    }
    const current = pkg ? state.release === pkg.version && state.digest === pkg.digest : state.commit === h.target;
    const active = h.run('systemctl', ['is-active', `${activeService}.service`], true).trim();
    if (h.recover) {
      if (!['configured', 'running'].includes(state.phase) || !['inactive', 'failed'].includes(active) ||
          h.run('ss', ['-H', '-ltn', `sport = :${port}`]).trim()) {
        throw new KakaoError('WORKER_IN_USE', 'Recovery requires a stopped configured installation and unused endpoint');
      }
      if (h.configureLogin) {
        await h.configureLogin(env, data, uid);
        const changed = parseEnv(fs.readFileSync(env, 'utf8'));
        for (const key of ['KAKAO_USER_ID', 'KAKAO_REGISTERED_DEVICE_UUID', 'KAKAO_ACCESS_TOKEN', 'KAKAO_DATA_DIR', 'KAKAO_MCP_LISTEN']) {
          if (changed[key] !== saved[key]) throw new KakaoError('STORAGE_UNSAFE', 'Repair changed protected account configuration; no start attempted');
        }
        saved = changed;
      }
      // A failed update stopped a daemon that had just passed its health check, so its saved session is what restarts it;
      // other recoveries may need a bounded re-login. Neither path forces a login.
      if (!pending && (!saved.KAKAO_EMAIL || !saved.KAKAO_PASSWORD || saved.KAKAO_ENABLE_TOKEN_REFRESH !== '1' ||
          !/^[1-3]$/.test(saved.KAKAO_AUTH_RELOGIN_MAX_ATTEMPTS ?? '3'))) {
        throw new KakaoError('CONFIG_INVALID', 'Recovery requires saved login data and explicitly enabled bounded re-login');
      }
    } else {
      if (active !== 'active' || !await h.healthy(saved.KAKAO_USER_ID, port)) throw new KakaoError('NOT_CONNECTED', 'Existing account health is unconfirmed; nothing was restarted');
      if (!isMigration && current) return;
    }

    const beforeEnvText = fs.readFileSync(env, 'utf8');
    const beforeEnvWithoutMoved = stripMovedPaths(beforeEnvText);
    const beforeDigest = digest();

    // Keep what is needed to put the pinned version back if the new one cannot be installed or built.
    // A package keeps a verified copy of its release files, taken while the daemon still runs.
    let rollbackReady = false;
    if (pkg) {
      if (digestOf(app) === state.digest) {
        fs.rmSync(rollbackDir, { recursive: true, force: true });
        fs.mkdirSync(rollbackDir, { mode: 0o700 });
        installRelease({ dir: app, version: state.release, digest: state.digest }, rollbackDir);
        rollbackReady = true;
      } else if (fs.existsSync(rollbackDir)) {
        protectedPath(rollbackDir, true);
        rollbackReady = digestOf(rollbackDir) === state.digest;
      }
    }

    if (!pkg) git(app, 'fetch', '--no-tags', '--depth', '1', h.repo, h.target);
    h.run('systemctl', ['stop', `${activeService}.service`]);
    const stopped = h.run('systemctl', ['is-active', `${activeService}.service`], true).trim();
    if (stopped !== 'inactive' && !(h.recover && stopped === 'failed') ||
        h.recover && h.run('ss', ['-H', '-ltn', `sport = :${port}`]).trim()) {
      throw new KakaoError('WORKER_IN_USE', 'Old daemon did not stop; no replacement started');
    }

    let finalService = activeService;
    let finalRoot = activeRoot;
    let finalUnit = activeUnit;
    const completedSteps: string[] = [`stop ${activeService}.service`];
    let currentStep = 'init';
    let updateFailed = false, updateError: unknown;
    const pendingPin = pkg ? pkg.digest : h.target;
    const oldLabel = pinLabel(state.release, pkg ? state.digest : state.commit), newLabel = pinLabel(pkg?.version, pendingPin);
    const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
    // Check out and build a pinned commit as the service user; installModules=false reuses the dependencies already in place.
    const buildSource = (commit: string, installModules: boolean) => {
      git(app, 'checkout', '--detach', commit);
      h.run('chown', ['-R', `${finalService}:${finalService}`, app]);
      if (installModules) {
        const cache = path.join(finalRoot, 'build-cache');
        fs.rmSync(cache, { recursive: true, force: true }); fs.mkdirSync(cache, { mode: 0o700 }); fs.chownSync(cache, uid, gid);
        h.run('runuser', ['-u', finalService, '--', h.node, h.npm, '--cache', cache, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], false, app);
        fs.rmSync(cache, { recursive: true });
      }
      h.run('runuser', ['-u', finalService, '--', h.node, path.join(app, 'node_modules/typescript/bin/tsc'), '-b', path.join(app, 'packages/protocol')], false, app);
    };
    const waitHealthy = async () => {
      for (let i = 0; i < (saved.KAKAO_ENABLE_TOKEN_REFRESH === '1' ? 180 : 10); i++) { if (await h.healthy(saved.KAKAO_USER_ID, port)) return true; await h.wait(); }
      return false;
    };

    try {
      if (isMigration) {
        currentStep = `disable ${legacyService}.service`;
        h.run('systemctl', ['disable', `${legacyService}.service`]);
        completedSteps.push(currentStep);

        currentStep = `acquire target lock in ${targetLock}`;
        try { targetFd = fs.openSync(targetLock, 'wx', 0o600); }
        catch { throw new KakaoError('WORKER_IN_USE', 'Target installation lock could not be acquired'); }
        fs.writeSync(targetFd, `${process.pid}\n`); fs.fsyncSync(targetFd);
        completedSteps.push(currentStep);

        currentStep = `rename root directory ${legacyRoot} to ${h.root}`;
        fs.renameSync(legacyRoot, h.root);
        finalRoot = h.root;
        finalService = service;
        finalUnit = h.unitFile;
        completedSteps.push(currentStep);

        app = path.join(finalRoot, 'app');
        data = path.join(finalRoot, 'data');
        stateFile = path.join(finalRoot, 'install-state.json');
        env = path.join(app, '.env.local');

        currentStep = `groupmod -n ${service} ${legacyService}`;
        h.run('groupmod', ['-n', service, legacyService]);
        completedSteps.push(currentStep);

        currentStep = `usermod -l ${service} ${legacyService}`;
        h.run('usermod', ['-l', service, legacyService]);
        completedSteps.push(currentStep);

        const newUid = Number(h.run('id', ['-u', service]).trim()), newGid = Number(h.run('id', ['-g', service]).trim());
        if (newUid !== uid || newGid !== gid) throw new KakaoError('CONFIG_INVALID', 'User migration changed UID/GID');

        currentStep = `rewrite KAKAO_DATA_DIR and KAKAO_AUDIT_LOG in ${env}`;
        const envRaw = fs.readFileSync(env, 'utf8');
        const updatedEnv = envRaw.replace(/^KAKAO_DATA_DIR=.*$/m, () => `KAKAO_DATA_DIR=${data}`)
          .replace(/^KAKAO_AUDIT_LOG=.*$/m, () => `KAKAO_AUDIT_LOG=${path.join(data, 'audit.log')}`);
        const tempEnv = `${env}.${randomUUID()}.tmp`;
        const envFd = fs.openSync(tempEnv, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
          fs.writeFileSync(envFd, updatedEnv);
          fs.fchownSync(envFd, uid, gid);
          fs.fsyncSync(envFd);
        } finally {
          fs.closeSync(envFd);
        }
        fs.renameSync(tempEnv, env);
        saved = readManagedEnv(env, false).values;
        completedSteps.push(currentStep);

        currentStep = `write ${finalUnit}`;
        fs.writeFileSync(finalUnit, serviceUnit(app, data, h.node, service), { mode: 0o644 });
        completedSteps.push(currentStep);

        currentStep = `remove ${legacyUnit}`;
        if (fs.existsSync(legacyUnit)) fs.unlinkSync(legacyUnit);
        completedSteps.push(currentStep);

        currentStep = `reload systemd and enable ${service}.service`;
        h.run('systemctl', ['daemon-reload']);
        h.run('systemctl', ['enable', `${service}.service`]);
        completedSteps.push(currentStep);
      }

      currentStep = `record pending update in ${stateFile}`;
      manifest(stateFile, { ...base, phase: 'configured', pendingUpdate: pendingPin });
      completedSteps.push(currentStep);

      currentStep = `build app in ${path.join(finalRoot, 'app')}`;
      if (pkg) installRelease(pkg, app);
      else {
        // A source app keeps the installed dependencies of the pinned commit aside, so putting it back needs no download.
        const modules = path.join(app, 'node_modules');
        if (!isMigration && git(app, 'rev-parse', 'HEAD') === state.commit && fs.existsSync(modules)) {
          fs.rmSync(rollbackDir, { recursive: true, force: true });
          fs.mkdirSync(rollbackDir, { mode: 0o700 });
          fs.renameSync(modules, path.join(rollbackDir, 'node_modules'));
        }
        rollbackReady = !isMigration;
        buildSource(h.target, true);
      }
      completedSteps.push(currentStep);
    } catch (err) {
      if (!isMigration && currentStep.startsWith('build app in')) {
        // Put the pinned version back. The daemon is started again below, after ownership and integrity checks.
        updateFailed = true; updateError = err;
        currentStep = `restore ${oldLabel} in ${app}`;
        try {
          if (!rollbackReady) throw new KakaoError('STORAGE_UNSAFE', 'No verified copy of the previous release is available');
          if (pkg) installRelease({ dir: rollbackDir, version: state.release, digest: state.digest }, app);
          else {
            const kept = path.join(rollbackDir, 'node_modules');
            const modules = path.join(app, 'node_modules');
            // Check out first: if that fails, the kept dependencies stay aside for the next recovery.
            git(app, 'checkout', '--detach', state.commit);
            const restored = fs.existsSync(kept);
            if (restored) { fs.rmSync(modules, { recursive: true, force: true }); fs.renameSync(kept, modules); }
            buildSource(state.commit, !restored);
          }
        } catch (restoreErr) {
          throw new KakaoError('STORAGE_UNSAFE', `Update to ${newLabel} failed and the previous version ${oldLabel} could not be restored. ` +
            `The service remains stopped; install-state.json records the unfinished update. Fix the cause, then run: ${recoverCommand}\n` +
            `Update error: ${errorText(err)}\nRestore error: ${errorText(restoreErr)}`);
        }
      } else if (isMigration) {
        const rootMoved = fs.existsSync(h.root);
        let instructions = '';
        if (!rootMoved) {
          const oldDisabled = completedSteps.includes(`disable ${legacyService}.service`);
          instructions = oldDisabled
            ? `Root remains at ${legacyRoot}. Old unit was disabled. Manual recovery:\nsudo systemctl enable --now ${legacyService}.service`
            : `Root remains at ${legacyRoot}. Old unit is stopped. Manual recovery:\nsudo systemctl start ${legacyService}.service`;
        } else if (currentStep.startsWith('build app in')) {
          instructions = `Migration finished; build failed. From the published checkout run: sudo node --experimental-strip-types apps/mcp/src/update-managed.ts --via-deploy ${h.target} "<reason>" --recover`;
        } else {
          const renamesNeeded: string[] = [];
          if (!completedSteps.includes(`groupmod -n ${service} ${legacyService}`)) {
            renamesNeeded.push(`sudo groupmod -n ${service} ${legacyService}`);
          }
          if (!completedSteps.includes(`usermod -l ${service} ${legacyService}`)) {
            renamesNeeded.push(`sudo usermod -l ${service} ${legacyService}`);
          }
          const recoverySteps: string[] = [];
          if (renamesNeeded.length > 0) {
            recoverySteps.push(`Verify user/group: ${renamesNeeded.join(' && ')}`);
          }
          recoverySteps.push(`Ensure ${h.root}/app/.env.local has KAKAO_DATA_DIR=${h.root}/data and, if set, KAKAO_AUDIT_LOG=${h.root}/data/audit.log (mode 0600, owner ${service})`);
          recoverySteps.push(`Install unit ${h.unitFile}, remove ${legacyUnit}, run: sudo systemctl daemon-reload && sudo systemctl enable --now ${service}.service`);
          instructions = `Root was moved to ${h.root}. Old unit is stopped. Manual recovery:\n` +
            recoverySteps.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
        }
        throw new KakaoError('STORAGE_UNSAFE', `Migration halted at "${currentStep}". Completed: [${completedSteps.join(', ')}].\n${instructions}\nError: ${errorText(err)}`);
      } else throw err;
    } finally {
      fs.rmSync(path.join(finalRoot, 'build-cache'), { recursive: true, force: true });
      if (fs.existsSync(app)) {
        h.run('chown', ['-R', `root:${finalService}`, app]); h.run('chmod', ['-R', 'u=rwX,g=rX,o=', app]);
      }
      if (fs.existsSync(env)) {
        fs.chownSync(env, uid, gid); fs.chmodSync(env, 0o600);
      }
    }

    if (isMigration) {
      const afterEnvText = fs.readFileSync(env, 'utf8');
      if (stripMovedPaths(afterEnvText) !== beforeEnvWithoutMoved) {
        throw new KakaoError('STORAGE_UNSAFE', 'Credential integrity changed during migration; service remains stopped');
      }
      if (saved.KAKAO_DATA_DIR !== data || (saved.KAKAO_AUDIT_LOG !== undefined && saved.KAKAO_AUDIT_LOG !== path.join(data, 'audit.log'))) {
        throw new KakaoError('STORAGE_UNSAFE', 'Data directory setting corrupted during migration; service remains stopped');
      }
    } else {
      if (digest() !== beforeDigest) throw new KakaoError('STORAGE_UNSAFE', 'Credential integrity changed; service remains stopped');
    }

    if (updateFailed) {
      // The previous pin is back on disk: verify it exactly, then start the same unit that was stopped. Only one daemon ever runs.
      const failure = `Update to ${newLabel} failed (${errorText(updateError)})`;
      if (digest() !== beforeDigest) throw new KakaoError('STORAGE_UNSAFE', `${failure}; credential integrity changed, so the service remains stopped`);
      if (pkg ? digestOf(app) !== state.digest : git(app, 'rev-parse', 'HEAD') !== state.commit || git(app, 'status', '--porcelain')) {
        throw new KakaoError('STORAGE_UNSAFE', `${failure}; the restored files differ from ${oldLabel}, so the service remains stopped. Fix the cause, then run: ${recoverCommand}`);
      }
      manifest(stateFile, { ...base, phase: 'configured' });
      if (h.recover) h.run('systemctl', ['reset-failed', `${finalService}.service`]);
      h.run('systemctl', ['start', `${finalService}.service`]);
      if (!await waitHealthy()) {
        throw new KakaoError('NOT_CONNECTED', `${failure}. The previous version ${oldLabel} was restored and started, but its account health is unconfirmed; no login or restart retry attempted. Check the service, then run: ${repairCommand}`);
      }
      manifest(stateFile, { ...base, phase: 'running' });
      fs.rmSync(rollbackDir, { recursive: true, force: true });
      throw new KakaoError(updateError instanceof KakaoError ? updateError.code : 'CONFIG_INVALID',
        `${failure}. The previous version ${oldLabel} was restored and is running on the same account; credentials and data are unchanged. Fix the cause, then update again`);
    }

    if (pkg ? releaseDigest(app) !== pkg.digest : git(app, 'rev-parse', 'HEAD') !== h.target || git(app, 'status', '--porcelain')) throw new KakaoError('STORAGE_UNSAFE', `Build integrity changed; service remains stopped. Run: ${recoverCommand}`);
    const pinned = pkg ? { release: pkg.version, digest: pkg.digest } : { commit: h.target };
    manifest(stateFile, { ...base, ...pinned, phase: 'configured' });
    if (h.recover) h.run('systemctl', ['reset-failed', `${finalService}.service`]);
    h.run('systemctl', ['start', `${finalService}.service`]);
    if (!await waitHealthy()) throw new KakaoError('NOT_CONNECTED', `Updated account health is unconfirmed; no login or restart retry attempted. Check the service, then run: ${repairCommand}`);
    manifest(stateFile, { ...base, ...pinned, phase: 'running' });
    fs.rmSync(path.join(finalRoot, 'rollback'), { recursive: true, force: true });
    const log = path.join(finalRoot, 'deploys.log'); if (fs.existsSync(log)) protectedPath(log, false);
    const logFd = fs.openSync(log, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const reasonSuffix = isMigration ? ` (migrated from ${legacyService})` : '';
      fs.writeSync(logFd, `${new Date().toISOString()} human ${pkg ? `${pkg.version} sha256:${pkg.digest}` : h.target} ${h.reason}${reasonSuffix}\n`);
      fs.fsyncSync(logFd);
    } finally {
      fs.closeSync(logFd);
    }
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    if (targetFd !== undefined) {
      fs.closeSync(targetFd);
      if (fs.existsSync(targetLock)) fs.unlinkSync(targetLock);
    }
  }
}

if (isMainModule(import.meta.url, 'update-managed')) {
  const main = async () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || ![5, 6].includes(process.argv.length) || process.argv[2] !== '--via-deploy' || (process.argv.length === 6 && !['--recover', '--repair'].includes(process.argv[5]))) {
      throw new KakaoError('POLICY_DENIED', packagedEntry() ? 'Use kakao-max setup --update or --repair' : 'Use sudo scripts/install.sh repair (or the operator deploy script for updates)');
    }
    const release = packagedEntry() ? protectedRelease(installRoot()) : undefined;
    const node = fs.realpathSync('/usr/bin/node'); protectedPath(node, false, 0);
    const npm = release ? '' : fs.realpathSync('/usr/bin/npm'); if (npm) protectedPath(npm, false, 0);
    await updateManaged({ repo: installRoot(), release, root: '/var/lib/kakao-max', unitFile: '/etc/systemd/system/kakao-max.service', legacyRoot: LEGACY_ROOT, legacyUnitFile: LEGACY_UNIT, node, npm, target: process.argv[3], reason: process.argv[4], recover: ['--recover', '--repair'].includes(process.argv[5]),
      configureLogin: process.argv[5] === '--repair' ? (file, data, uid) => configureManagedLogin(file, data, uid, terminalPrompt) : undefined,
      run: (program, args, allowFailure, cwd) => {
        const command = ['/usr/bin', '/usr/sbin', '/bin', '/sbin'].map(dir => path.join(dir, program)).find(p => fs.existsSync(p));
        if (!command) throw new KakaoError('CONFIG_INVALID', 'Update prerequisite missing'); protectedPath(fs.realpathSync(command), false, 0);
        const r = spawnSync(command, args, { encoding: 'utf8', cwd });
        if (r.error || r.status !== 0 && !allowFailure) throw new KakaoError('CONFIG_INVALID', `${program} failed; no automatic retry (exit ${r.status})`);
        return r.stdout;
      }, healthy: (expected, port) => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1'); socket.setTimeout(2000);
        const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.once('connect', () => { socket.setTimeout(0); probe(socket, 3000).then(r => finish(r.healthy && r.userId === expected)); });
        socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
      }), wait: () => new Promise(resolve => setTimeout(resolve, 1000)) });
    process.stderr.write(`[update] Managed daemon connected${release ? ` on ${releaseLabel(release.version, release.digest)}` : ''}; credentials preserved; no registration performed\n`);
  };
  main().catch(e => { process.stderr.write(`[update] ${e instanceof KakaoError ? e.message : 'Update stopped; review managed state'}\n`); process.exitCode = 1; });
}
