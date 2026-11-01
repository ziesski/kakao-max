// Explicit Linux OS verification, and a short-lived SSH fixture. Never opens a Kakao session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type net from 'node:net';
import { AgentSendJournal, AgentSendService, ApprovalStore, ApproverRegistry, SendPolicy } from '@kakao-max/core';
import { bootstrapLocal, serviceUnit } from './setup-system.ts';
import { McpStdioServer } from './mcp-stdio.ts';
import { ElicitationApprovals } from './client-approval.ts';
import { registerAgentMessageTools } from './tools/agent-messages.ts';
import { serveSocket } from './socket-transport.ts';

function checked(command: string, args: string[], timeout = 40000): string {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout });
  assert.equal(r.error, undefined, `${command}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${command}: ${r.stderr}`);
  return r.stdout;
}

async function sshFixture(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-ssh-fixture-')), journal = AgentSendJournal.open(root);
  const approvals = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
  let sends = 0;
  const service = new AgentSendService({ principal: 'local-mcp', journal, approvals,
    policy: new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(root, 'audit') }),
    adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture local metadata',
      send: async () => { sends++; return { status: 0, logId: '1' }; } } });
  const mcp = new McpStdioServer({ name: 'kakao-ssh-fixture', version: '0' });
  mcp.setClientApproval(new ElicitationApprovals(approvals)); registerAgentMessageTools(mcp, () => service);
  const server = serveSocket(mcp, { host: '127.0.0.1', port: 0 }), sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => {
    sockets.delete(socket); if (sends === 1) server.close();
  }); });
  const timer = setTimeout(() => { for (const s of sockets) s.destroy(); server.close(); }, 30000);
  try {
    await once(server, 'listening');
    process.stdout.write(JSON.stringify({ fixturePort: (server.address() as net.AddressInfo).port }) + '\n');
    await once(server, 'close'); assert.equal(sends, 1, 'Exactly one fixture adapter call, no actual Kakao write');
  } finally { clearTimeout(timer); for (const s of sockets) s.destroy(); journal.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes('--serve-ssh-fixture')) {
  await sshFixture();
} else {
  test('Linux systemd validates the production unit and enforces code/data isolation in a temporary non-networked fixture',
    { skip: !process.argv.includes('--linux-os-fixture') }, async t => {
      assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0);
      const root = fs.mkdtempSync('/run/kakao-max-verify-'), app = path.join(root, 'app'), data = path.join(root, 'data');
      const unit = `kakao-max-verify-${randomUUID()}.service`;
      const role = `ktmcpv-${randomBytes(5).toString('hex')}`;
      let created = false;
      t.after(() => {
        // --collect can unload the finished transient unit between show and stop.
        const stopped = spawnSync('systemctl', ['stop', unit], { encoding: 'utf8', timeout: 40000 });
        assert.equal(stopped.error, undefined);
        if (stopped.status !== 0) {
          assert.equal(stopped.status, 5, stopped.stderr);
          assert.equal(checked('systemctl', ['show', unit, '--property=LoadState', '--value']).trim(), 'not-found');
          assert.equal(checked('systemctl', ['show', unit, '--property=ActiveState', '--value']).trim(), 'inactive');
        }
        if (created) checked('userdel', [role]);
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.chmodSync(root, 0o755); fs.mkdirSync(path.join(app, 'apps/mcp/src'), { recursive: true, mode: 0o755 });
      fs.mkdirSync(data, { mode: 0o700 });
      checked('useradd', ['--system','--user-group','--no-create-home','--home-dir',root,'--shell','/usr/sbin/nologin',role]); created = true;
      const uid = Number(checked('id', ['-u', role]).trim()), gid = Number(checked('id', ['-g', role]).trim());
      assert.ok(uid > 0 && Number.isSafeInteger(gid)); fs.chownSync(data, uid, gid);
      const env = path.join(app, '.env.local'); fs.writeFileSync(env, 'fixture=true\n', { mode: 0o600 }); fs.chownSync(env, uid, gid);
      const protectedFile = path.join(root, 'operator-only'); fs.writeFileSync(protectedFile, 'fixture marker', { mode: 0o600 });
      fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
      const entry = path.join(app, 'apps/mcp/src/index.ts');
      // All files are temporary fixture artifacts created here; no account or production entry point is run.
      fs.writeFileSync(entry, `import fs from 'node:fs'; import assert from 'node:assert/strict';
const [data,env,code,secret,uid] = process.argv.slice(2);
assert.equal(process.getuid(), Number(uid));
fs.writeFileSync(data+'/write-ok','ok'); fs.appendFileSync(env,'updated=true\\n');
for (const target of [code,secret]) assert.throws(() => fs.writeFileSync(target,'denied'), e => ['EACCES','EROFS'].includes(e.code));
assert.throws(() => fs.readFileSync(secret), {code:'EACCES'});
`);
      // Match the installer's permissions even with umask 077 in the remote verification shell.
      checked('chown', ['-R', `root:${role}`, app]); checked('chmod', ['-R', 'u=rwX,g=rX,o=', app]);
      fs.chownSync(env, uid, gid); fs.chmodSync(env, 0o600);
      const generated = serviceUnit(app, data, process.execPath).replace(/^User=kakao-max$/m, `User=${role}`).replace(/^Group=kakao-max$/m, `Group=${role}`);
      const unitFile = path.join(root, unit); fs.writeFileSync(unitFile, generated);
      checked('systemd-analyze', ['verify', unitFile]);
      checked('systemd-run', ['--quiet', '--wait', '--collect', `--unit=${unit}`, '--property=Type=exec', `--property=User=${role}`,
        `--property=Group=${role}`, `--property=WorkingDirectory=${app}`, '--property=ProtectSystem=strict', '--property=ProtectHome=true',
        '--property=NoNewPrivileges=true', '--property=PrivateTmp=true', '--property=CapabilityBoundingSet=',
        '--property=RestrictAddressFamilies=AF_UNIX', '--property=RuntimeMaxSec=20', '--property=UMask=0077',
        `--property=ReadWritePaths=${data} ${env}`, process.execPath, '--experimental-strip-types', entry, data, env, entry, protectedFile, String(uid)]);
      assert.equal(fs.readFileSync(path.join(data, 'write-ok'), 'utf8'), 'ok');
      assert.equal(fs.statSync(path.join(data, 'write-ok')).uid, uid);
      assert.match(fs.readFileSync(env, 'utf8'), /updated=true/); assert.equal(fs.statSync(entry).uid, 0);
      console.log('Linux systemd: production unit parsed; code/protected-file writes denied; private data/env writes succeeded.');
    });

  test('Linux real Git/npm/service-user bootstrap reaches configured state with injected registration and no daemon start',
    { skip: !process.argv.includes('--linux-os-fixture') || !process.argv.includes('--published-main-fixture'), timeout: 120000 }, async t => {
      assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0);
      const parent = fs.mkdtempSync('/run/kakao-max-build-'); fs.chmodSync(parent, 0o755);
      const role = `kakao-max-${randomBytes(4).toString('hex')}`, root = path.join(parent, 'managed');
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      let created = false, registrations = 0;
      t.after(() => {
        try {
          if (created) {
            // A failed npm child belongs only to this unique fixture identity; never target another user.
            const killed = spawnSync('pkill', ['-TERM','-u',role]);
            assert.ok(killed.status === 0 || killed.status === 1, 'fixture process cleanup failed');
            checked('userdel', [role]);
          }
        } finally { fs.rmSync(parent, { recursive: true, force: true }); }
      });
      const sourceIndex = checked('git', ['--no-optional-locks','-c',`safe.directory=${repo}`,'-C',repo,'rev-parse','--path-format=absolute','--git-path','index']).trim();
      const originalIndexOwner = fs.statSync(sourceIndex).uid;
      const allowed = new Set(['git','getent','useradd','id','chown','chmod','runuser']);
      const oldMask = process.umask(0o077);
      try {
        const result = await bootstrapLocal({ root, repo, port: 18787,
          serviceName: role, unitFile: path.join(parent, `${role}.service`), node: process.execPath,
          npm: fs.realpathSync(path.join(path.dirname(process.execPath), 'npm')), reason: 'isolated Linux build fixture',
          run: (program, args, allowFailure, cwd) => {
            assert.ok(allowed.has(program), `unexpected production effect ${program}`);
            const r = spawnSync(program, args, { encoding: 'utf8', cwd, timeout: 60000 });
            if (program === 'useradd' && r.status === 0) created = true;
            assert.equal(r.error, undefined, `${program}: ${r.error?.message}`);
            if (!allowFailure) assert.equal(r.status, 0, `${program}: ${r.stderr}`);
            return r.status === 0 ? r.stdout : '';
          },
          prompt: async (question, secret) => {
            if (secret) return 'fixture password';
            if (question.includes('자동 재로그인을 위해')) return 'n';
            if (question.startsWith('에이전트 모드')) return '';
            if (question.includes('이메일')) return 'fixture@example.test';
            if (question.includes('시작할까요')) return 'n'; // Hard boundary: no production index/session is started.
            throw new Error('unexpected account prompt');
          },
          register: async (_email, _password, uuid, takeover) => {
            assert.equal(takeover, false); registrations++;
            return { status: 0, deviceUuid: uuid, credentials: { userId: '123456789', accessToken: 'fixture token' } };
          },
          log: () => {}, occupied: async () => false, healthy: async () => false, wait: async () => {} });
        assert.equal(result, 'configured'); assert.equal(registrations, 1);
        assert.equal(fs.statSync(path.join(root, 'app/packages/protocol/dist/index.js')).uid, 0);
        assert.equal(fs.statSync(path.join(root, 'app/packages/protocol/dist/index.js')).mode & 0o777, 0o640);
        const uid = Number(checked('id', ['-u',role]).trim());
        assert.equal(fs.statSync(path.join(root, 'app/.env.local')).uid, uid);
        assert.equal(fs.statSync(path.join(root, 'app/.env.local')).mode & 0o777, 0o600);
        assert.match(fs.readFileSync(path.join(root, 'app/.env.local'), 'utf8'), /KAKAO_MCP_LISTEN=127\.0\.0\.1:18787/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'install-state.json'), 'utf8')).port, 18787);
        assert.ok(!fs.existsSync(path.join(root, 'build-cache')));
        assert.ok(!fs.existsSync(path.join(parent, `${role}.service`)));
        assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
        assert.equal(fs.statSync(sourceIndex).uid, originalIndexOwner, 'root preflight must not take ownership of the operator index');
        console.log('Linux bootstrap: real Git clone/npm/tsc/user permissions passed; registration injected; startup declined.');
      } finally { process.umask(oldMask); }
    });
}
