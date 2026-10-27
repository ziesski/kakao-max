import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/check-publication.mjs', import.meta.url));
const ignore = fs.readFileSync(new URL('../../../.gitignore', import.meta.url));

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env });
  git('init', '-q');
  const add = (file: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data); git('add', '--force', '--', file);
  };
  const check = () => spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
  return { root, git, add, check };
}

test('publication guard accepts source fixtures and ordinary media without reading untracked account data', t => {
  const f = fixture(t);
  f.add('source.test.ts', 'const fixture = { text: "synthetic message" };');
  f.add('assets/demo.gif', 'GIF89a fixture');
  fs.writeFileSync(path.join(f.root, '.env.local'), 'UNTRACKED_PRIVATE_SENTINEL');
  assert.equal(f.check().status, 0);
});

test('publication guard rejects forcibly tracked private paths and removed account files in history', t => {
  const f = fixture(t);
  f.add('nested/credentials.json', '{"fixture":"private"}');
  assert.equal(f.check().status, 1);
  f.git('commit', '-qm', 'fixture account file');
  f.git('rm', '-q', '--', 'nested/credentials.json');
  f.add('source.ts', 'export {};'); f.git('commit', '-qm', 'fixture removal');
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /Git history/);
  assert.equal(result.stderr.includes('nested/credentials.json'), false);
  assert.equal(result.stderr.includes('private"'), false);
});

test('publication guard recognizes a SQLite file even with an innocent filename', t => {
  const f = fixture(t); f.add('notes.txt', Buffer.from('SQLite format 3\0fixture-private-data'));
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /SQLite account data/);
  assert.equal(result.stderr.includes('fixture-private'), false);
});

test('Git excludes account stores and exports without excluding TypeScript fixtures', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, '.gitignore'), ignore);
  for (const file of ['.kakao-max/kakao.db', '.kakao/kakao.db', 'nested/kakao.db-wal', 'x.sqlite3-shm',
    'vault/exports/123.html', 'downloads/123/photo.jpg', 'nested/friends.json.migrated-123',
    'messages.jsonl', 'frames.jsonl', 'credentials.json', 'approver-enroll.json', 'auth-relogin.json']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: f.root });
    assert.equal(result.status, 0, file);
  }
  assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', 'src/credentials.test.ts'], { cwd: f.root }).status, 1);
});
