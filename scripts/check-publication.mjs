#!/usr/bin/env node
// Inspect Git objects only. Never open local account stores or print rejected paths/contents.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const privateDirectory = /(?:^|\/)(?:\.kakao(?:-max)?|vault|downloads|secrets|rea)(?:\/|$)/i;
const privateFile = /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3)(?:-.*)?|.*\.(?:pem|key|pcap|pcapng|har)|(?:messages\.jsonl|frames\.jsonl|friends\.json|known-chats\.json|credentials\.json|approvers\.json|approver-enroll\.json|auth-relogin\.json|install-state\.json).*)$/i;

try {
  const entries = [];
  // Include staged changes as well as removed files in any reachable branch/tag history.
  for (const row of git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    entries.push({ path: row.slice(tab + 1), oid: row.slice(0, tab).split(' ')[1] });
  }
  for (const commit of git('rev-list', '--all').toString().trim().split('\n').filter(Boolean)) {
    for (const row of git('ls-tree', '-r', '-z', commit).toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), [, type, oid] = row.slice(0, tab).split(' ');
      if (type === 'blob') entries.push({ path: row.slice(tab + 1), oid });
    }
  }
  const paths = new Set(entries.map(e => e.path));
  if ([...paths].some(p => privateDirectory.test(p) || privateFile.test(p))) {
    throw new Error('Sensitive account, credential or capture path found in the index or Git history');
  }
  const blobs = new Set(entries.map(e => e.oid));
  for (const oid of blobs) {
    if (git('cat-file', 'blob', oid).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      throw new Error('SQLite account data found in the index or Git history');
    }
  }
  process.stdout.write(`Publication guard passed: ${paths.size} paths, ${blobs.size} blobs\n`);
} catch (error) {
  // Git failures can contain file paths and other private data; report only our fixed diagnostics.
  const known = ['Sensitive account, credential or capture path found in the index or Git history', 'SQLite account data found in the index or Git history'];
  process.stderr.write(`Publication guard failed: ${known.includes(error?.message) ? error.message : 'Git object inspection failed'}\n`);
  process.exitCode = 1;
}
