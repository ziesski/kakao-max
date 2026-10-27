// ----------------------------------------------------------------------------
// Check a recorded fixture for leaks before it is committed.
//
//   node --experimental-strip-types packages/core/scripts/check-fixture-leaks.ts <fixture.jsonl> [kakao.db] [.env.local]
//
// Fails (exit 1) if the fixture contains:
//   - any string other than "s:<n>" placeholders, "bin", and chat-type enums
//   - any real id from the local database (friends, chats, message authors, logIds)
//   - the account's user id, access/refresh token, or device uuid
// Run it on the machine that recorded the fixture (where the real data lives).
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [fixture, dbPath = path.join(os.homedir(), '.kakao', 'kakao.db'), envPath = '.env.local'] = process.argv.slice(2);
if (!fixture) {
  console.error('usage: check-fixture-leaks.ts <fixture.jsonl> [kakao.db] [.env.local]');
  process.exit(2);
}

const real = new Set<string>();
const db = new DatabaseSync(dbPath, { readOnly: true });
const add = (v: unknown) => {
  if (v != null && String(v).length >= 4) real.add(String(v));
};
for (const r of db.prepare('SELECT user_id, data FROM friends').all() as Array<{ user_id: string; data: string }>) {
  add(r.user_id);
  const f = JSON.parse(r.data);
  add(f.accountId);
}
for (const r of db.prepare('SELECT id FROM known_chats').all() as Array<{ id: string }>) add(r.id);
for (const r of db.prepare('SELECT DISTINCT chat_id, author_id FROM messages').all() as Array<{ chat_id: string; author_id: string }>) {
  add(r.chat_id);
  add(r.author_id);
}
for (const r of db.prepare('SELECT message_id FROM messages').all() as Array<{ message_id: string }>) add(r.message_id);
db.close();

const secrets: string[] = [];
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^(KAKAO_USER_ID|KAKAO_ACCESS_TOKEN|KAKAO_REFRESH_TOKEN|KAKAO_REGISTERED_DEVICE_UUID|KAKAO_EMAIL)=(.+)$/);
    if (m && m[2].trim().length >= 4) {
      secrets.push(m[2].trim());
      real.add(m[2].trim());
    }
  }
}

const problems: string[] = [];
const raw = fs.readFileSync(fixture, 'utf8');
for (const s of secrets) if (raw.includes(s)) problems.push(`account secret/id found verbatim (length ${s.length})`);

const ALLOWED_STRING = /^(?:s:\d+|s:\?|bin|[A-Z][A-Za-z]{1,20}Chat|OM|OD|in|out)$/;
let frames = 0;
const walk = (v: unknown, where: string) => {
  if (typeof v === 'string') {
    if (real.has(v)) problems.push(`${where}: real id ${v.slice(0, 3)}…`);
    else if (!ALLOWED_STRING.test(v) && !/^-?\d+$/.test(v)) problems.push(`${where}: unsanitized string "${v.slice(0, 12)}…"`);
  } else if (typeof v === 'number') {
    if (real.has(String(v))) problems.push(`${where}: real id ${String(v).slice(0, 3)}…`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${where}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (real.has(k)) problems.push(`${where}: real id used as key`);
      walk(x, `${where}.${k}`);
    }
  }
};
for (const [i, line] of raw.split('\n').entries()) {
  if (!line.trim()) continue;
  const f = JSON.parse(line);
  frames++;
  walk(f.body, `line ${i + 1} ${f.dir} ${f.method}`);
}

console.log(`checked ${frames} frames against ${real.size} real ids`);
if (problems.length) {
  console.error(`LEAKS (${problems.length}):\n  ` + problems.slice(0, 50).join('\n  '));
  process.exit(1);
}
console.log('no leaks found');
