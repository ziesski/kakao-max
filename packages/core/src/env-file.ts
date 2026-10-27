// ----------------------------------------------------------------------------
// `.env.local` discovery and parsing, shared by credentials, policy and config.
// The file is gitignored and holds account secrets; it is found by walking up
// from the working directory (the daemon runs with WorkingDirectory=<checkout>).
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

/** Walk up from `startDir` looking for .env.local; returns its path (even if absent). */
export function findEnvFile(startDir = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const p = path.resolve(dir, '.env.local');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '.env.local');
}

/** Parse KEY=VALUE lines; blank lines and `#` comments are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx !== -1) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

/** The parsed file, or {} when it does not exist. */
export function readEnvFile(envPath: string): Record<string, string> {
  return fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf-8')) : {};
}
