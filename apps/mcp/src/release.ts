// A managed install from the published package pins the package's own files: its version and a SHA-256 over
// package.json, LICENSE and dist/. The copy under the service root is checked against that digest before the
// daemon starts, the same way a source install checks its pinned Git commit.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KakaoError } from '@kakao-max/core';

export interface Release { dir: string; version: string; digest: string }

const RELEASE_ENTRIES = ['package.json', 'LICENSE', 'dist'];
const PACKAGE_NAME = 'kakao-max';
export const RELEASE_DIGEST = /^[a-f0-9]{64}$/;
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Release files under `dir`, as sorted POSIX paths. Links and special files are refused, not followed. */
export function releaseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const full = path.join(dir, rel), stat = fs.lstatSync(full);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(full)) walk(path.join(rel, name)); return; }
    if (!stat.isFile()) throw new KakaoError('STORAGE_UNSAFE', 'Release files must be regular files');
    out.push(rel.split(path.sep).join('/'));
  };
  for (const entry of RELEASE_ENTRIES) walk(entry);
  return out.sort();
}

export function releaseDigest(dir: string): string {
  const hash = createHash('sha256');
  for (const rel of releaseFiles(dir)) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    hash.update(`${rel}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

/** The package this program runs from. Only the published kakao-max package is installed as a service. */
export function readRelease(dir: string): Release {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string' || !RELEASE_VERSION.test(manifest.version)) {
    throw new KakaoError('CONFIG_INVALID', 'This program is not running from a kakao-max package');
  }
  return { dir, version: manifest.version, digest: releaseDigest(dir) };
}

/** Copy the release into `app` (which keeps its .env.local) and confirm the copy matches the pinned digest. */
export function installRelease(release: Release, app: string): void {
  removeRelease(app);
  for (const rel of releaseFiles(release.dir)) {
    const to = path.join(app, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(release.dir, rel), to, fs.constants.COPYFILE_EXCL);
  }
  if (releaseDigest(app) !== release.digest) throw new KakaoError('STORAGE_UNSAFE', 'Installed files differ from the pinned release; no account operation attempted');
}

export function removeRelease(app: string): void {
  for (const entry of RELEASE_ENTRIES) fs.rmSync(path.join(app, entry), { recursive: true, force: true });
}

export function releaseLabel(version: string, digest: string): string {
  return `${version} (sha256 ${digest.slice(0, 12)})`;
}
