// One-time passkey enrollment code. Created only from an interactive terminal on the daemon host
// (src/approver.ts); the agent has no tool that can create, read or extend it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readOwnerOnlyJson, writeOwnerOnlyJson } from '@kakao-max/core';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
interface Enrollment { codeHash: string; expiresAt: number; attempts: number }

export function enrollmentFile(dataDir: string): string { return path.join(dataDir, 'approver-enroll.json'); }
const hash = (code: string) => createHash('sha256').update(code.replace(/[^A-Z0-9]/gi, '').toUpperCase()).digest('hex');

/** Replaces any previous code. Returns the code to show once on the operator terminal. */
export function createEnrollment(dataDir: string, now = Date.now()): { code: string; expiresAt: number } {
  const raw = [...randomBytes(10)].map(b => ALPHABET[b % ALPHABET.length]).join('');
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  writeOwnerOnlyJson(enrollmentFile(dataDir), { codeHash: hash(code), expiresAt: now + TTL, attempts: 0 } satisfies Enrollment);
  return { code, expiresAt: now + TTL };
}

/** Constant-time check; wrong guesses are counted durably and exhaust the code. */
export function checkEnrollment(dataDir: string, code: unknown, now = Date.now()): boolean {
  const file = enrollmentFile(dataDir), e = readOwnerOnlyJson(file) as Enrollment | undefined;
  if (!e || typeof e.codeHash !== 'string' || !Number.isSafeInteger(e.expiresAt) || !Number.isSafeInteger(e.attempts)) return false;
  if (e.expiresAt <= now || e.attempts >= MAX_ATTEMPTS) { clearEnrollment(dataDir); return false; }
  const ok = typeof code === 'string' && code.length <= 32 && timingSafeEqual(Buffer.from(hash(code), 'hex'), Buffer.from(e.codeHash, 'hex'));
  if (!ok) {
    if (e.attempts + 1 >= MAX_ATTEMPTS) clearEnrollment(dataDir);
    else writeOwnerOnlyJson(file, { ...e, attempts: e.attempts + 1 });
  }
  return ok;
}
export function clearEnrollment(dataDir: string): void {
  try { fs.unlinkSync(enrollmentFile(dataDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
