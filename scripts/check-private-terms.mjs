#!/usr/bin/env node
// Reject private terms in what is about to become public: added lines, file names, commit messages and PR text.
// Reports only where a match is, never the matched value or a maintainer pattern, so CI logs reveal neither.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024 }).toString();
const ZERO = /^0+$/;

// Safe to publish: these describe kinds of data, not anything about this project.
const PUBLIC = [
  // Korean mobile numbers, except the all-zero and 1234-5678 placeholders tests use.
  ['phone number', /(?<!\d)01[016789][- .]?(?!0{3,4}[- .]?0{4}(?!\d)|1234[- .]?5678(?!\d))\d{3,4}[- .]?\d{4}(?!\d)/],
  ['email address', /(?<![\w.+-])[\w.+-]+@(?!(?:example\.(?:com|org|net)|[\w-]+\.(?:test|example|invalid)|users\.noreply\.github\.com)\b)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i],
];

/** Maintainer terms: the KAKAO_MAX_DENYLIST text, or a file from KAKAO_MAX_DENYLIST_FILE or `git config kakao-max.denylist`. */
function privatePatterns() {
  let text = process.env.KAKAO_MAX_DENYLIST;
  if (!text) {
    let file = process.env.KAKAO_MAX_DENYLIST_FILE;
    if (!file) try { file = git('config', '--get', '--path', 'kakao-max.denylist').trim(); } catch { /* not configured */ }
    if (file && existsSync(file)) text = readFileSync(file, 'utf8');
  }
  if (!text) return undefined;
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map((source, i) => [`private term #${i + 1}`, new RegExp(source, 'i')]);
}

function parseArgs(argv) {
  const o = { commits: [], texts: [], messageFiles: [], trees: [], staged: false, prePush: undefined, requirePrivate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    // `--commits` takes the rest of the arguments as `git rev-list` arguments (e.g. HEAD --not BASE).
    if (a === '--commits') { o.commits.push(...argv.slice(i + 1)); break; }
    else if (a === '--message-file') o.messageFiles.push(next());
    else if (a === '--text-env') o.texts.push(next());
    else if (a === '--tree') o.trees.push(next());
    else if (a === '--staged') o.staged = true;
    else if (a === '--pre-push') o.prePush = next();
    else if (a === '--require-private') o.requirePrivate = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

/** Added lines of a unified diff, with their file and new line number. */
function* addedLines(diff) {
  let file, line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) file = row === '+++ /dev/null' ? undefined : row.slice(6);
    else if (row.startsWith('@@')) line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (row.startsWith('+') && file) yield { where: `${file}:${line++}`, text: row.slice(1) };
    else if (!row.startsWith('-') && !row.startsWith('\\')) line++;
  }
}

function commitMessage(text) {
  return text.split(/^# -+ >8 -+$/m)[0].split('\n').filter(l => !l.startsWith('#')).join('\n');
}

function* subjects(o) {
  for (const f of o.messageFiles) yield { where: 'commit message', text: commitMessage(readFileSync(f, 'utf8')) };
  for (const name of o.texts) yield { where: `pull request ${name.toLowerCase().replace(/^pr_/, '')}`, text: process.env[name] ?? '' };
  if (o.staged) {
    yield* addedLines(git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames'));
    for (const p of git('diff', '--cached', '--name-only', '--diff-filter=AR', '-z').split('\0').filter(Boolean)) yield { where: 'a staged file name', text: p };
  }
  const ranges = o.commits.length ? [o.commits] : [];
  if (o.prePush) {
    for (const row of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      const [, local, , remote] = row.split(' ');
      if (ZERO.test(local)) continue;
      ranges.push(ZERO.test(remote) ? [local, '--not', `--remotes=${o.prePush}`] : [local, '--not', remote]);
    }
  }
  for (const range of ranges) {
    const args = range.filter((r, i) => !(ZERO.test(r) && range[i - 1] === '--not')).filter((r, i, a) => !(r === '--not' && i === a.length - 1));
    for (const c of git('rev-list', ...args).split('\n').filter(Boolean)) {
      const short = c.slice(0, 7);
      yield { where: `commit ${short} message`, text: git('log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%B', c) };
      if (git('rev-list', '--parents', '-1', c).trim().split(' ').length > 2) continue;
      for (const s of addedLines(git('diff-tree', '-p', '-U0', '--root', '--no-commit-id', '--no-color', '--no-ext-diff', '--no-renames', '-r', c))) yield { ...s, where: `commit ${short} ${s.where}` };
      for (const p of git('diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=AR', '-r', '-z', c).split('\0').filter(Boolean)) yield { where: `a file name in commit ${short}`, text: p };
    }
  }
  for (const rev of o.trees) {
    for (const row of git('ls-tree', '-r', '-z', rev).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), [, type, oid] = row.slice(0, tab).split(' '), path = row.slice(tab + 1);
      yield { where: 'a file name in the tree', text: path };
      if (type !== 'blob' || path === 'package-lock.json') continue;
      const blob = execFileSync('git', ['cat-file', 'blob', oid], { maxBuffer: 256 * 1024 * 1024 });
      if (blob.includes(0)) continue;
      const lines = blob.toString().split('\n');
      for (let i = 0; i < lines.length; i++) yield { where: `${path}:${i + 1}`, text: lines[i] };
    }
  }
}

try {
  const o = parseArgs(process.argv.slice(2));
  const priv = privatePatterns();
  if (!priv && o.requirePrivate) throw new Error('The maintainer deny list is required here but was not provided');
  if (!priv) process.stderr.write('Private-terms check: maintainer list not found, checking public patterns only\n');
  const patterns = [...PUBLIC, ...(priv ?? [])];
  const hits = [];
  for (const { where, text } of subjects(o)) {
    for (const [label, re] of patterns) if (re.test(text)) hits.push(`${where}: ${label}`);
  }
  if (hits.length) {
    process.stderr.write(`Private-terms check failed. Rewrite these in product terms (never bypass the check):\n${[...new Set(hits)].map(h => `  ${h}`).join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Private-terms check passed\n');
} catch (error) {
  // Git errors can echo file contents; keep our own message only.
  process.stderr.write(`Private-terms check failed: ${error?.message?.startsWith('Unknown argument') || error?.message?.startsWith('The maintainer') ? error.message : 'Git object inspection failed'}\n`);
  process.exitCode = 1;
}
