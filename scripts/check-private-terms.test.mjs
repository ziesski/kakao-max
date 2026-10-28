import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./check-private-terms.mjs', import.meta.url));
const generated = ['noreply', 'github.com'].join('@');
const privateEmail = ['fixture-person', 'fixture-company.org'].join('@');
function scan(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kakao-scanner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, KAKAO_MAX_DENYLIST: options.deny ?? 'fixture-never-match',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: options.authorEmail ?? 'fixture@example.com',
    GIT_COMMITTER_NAME: options.committerName ?? 'GitHub', GIT_COMMITTER_EMAIL: options.committerEmail ?? generated };
  const git = args => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init']); writeFileSync(path.join(dir, 'fixture.txt'), options.content ?? 'fixture\n');
  git(['add', 'fixture.txt']); git(['commit', '-m', options.body ?? 'fixture commit']);
  return spawnSync(process.execPath, [scanner, '--require-private', ...(options.tree ? ['--tree', 'HEAD'] : ['--commits', 'HEAD'])], { cwd: dir, env, encoding: 'utf8' });
}
test('GitHub-generated squash committer metadata passes', t => {
  const result = scan(t); assert.equal(result.status, 0, result.stderr);
});
test('personal author and committer emails remain blocked', async t => {
  for (const options of [{ authorEmail: privateEmail }, { committerEmail: privateEmail }, { committerName: 'fixture', committerEmail: generated }]) {
    const result = scan(t, options); assert.equal(result.status, 1); assert.match(result.stderr, /email address/);
    assert.ok(!result.stderr.includes(privateEmail));
  }
});
test('the generated address is still blocked in commit bodies and source trees', t => {
  for (const options of [{ body: 'fixture ' + generated }, { content: generated, tree: true }]) {
    const result = scan(t, options); assert.equal(result.status, 1); assert.match(result.stderr, /email address/);
  }
});
test('maintainer patterns still inspect generated committer metadata', t => {
  const blocked = scan(t, { deny: 'GitHub' });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /committer: private term/);
});
