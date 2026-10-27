// Durable limits survive systemd restarts. Contains counters only, never credentials.
import fs from 'node:fs';
import path from 'node:path';
import { KakaoError } from './errors.ts';
import { isOwnerOnly, fsyncDir } from './private-fs.ts';

const WINDOW_MS = 24 * 60 * 60 * 1000;
interface State { version: 1; since: number; attempts: number; stopped: boolean }
export class AuthReloginBudget {
  constructor(privateFile: string, maxAttempts = 3, now: () => number = Date.now) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new KakaoError('CONFIG_INVALID', 'Re-login limit must be between one and three');
    this.file = privateFile; this.maxAttempts = maxAttempts; this.now = now;
  }
  private readonly file: string;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private change(reserve: boolean): boolean {
    const dir = fs.lstatSync(path.dirname(this.file));
    if (!dir.isDirectory() || dir.isSymbolicLink() || !isOwnerOnly(dir)) {
      throw new KakaoError('STORAGE_UNSAFE', 'Unsafe re-login budget directory');
    }
    let lock: number;
    try { lock = fs.openSync(`${this.file}.lock`, 'wx', 0o600); }
    catch { throw new KakaoError('STORAGE_UNSAFE', 'Re-login budget locked; inspect before retrying'); }
    try {
      const now = this.now();
      let state: State = { version: 1, since: now, attempts: 0, stopped: false };
      try {
        const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || !isOwnerOnly(stat) || stat.size > 1024) throw new Error('unsafe');
          state = JSON.parse(fs.readFileSync(fd, 'utf8'));
        } finally { fs.closeSync(fd); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new KakaoError('STORAGE_UNSAFE', 'Invalid re-login budget; inspect before retrying');
      }
      if (state.version !== 1 || !Number.isSafeInteger(state.since) || state.since < 0 || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || typeof state.stopped !== 'boolean') {
        throw new KakaoError('STORAGE_UNSAFE', 'Invalid re-login budget; inspect before retrying');
      }
      // Clock rollback does not give extra attempts. Rejections require an operator
      // to fix credentials and explicitly remove this counter file, even after a day.
      if (!state.stopped && now >= state.since + WINDOW_MS) state = { version: 1, since: now, attempts: 0, stopped: false };
      if (reserve && (state.stopped || state.attempts >= this.maxAttempts)) return false;
      if (reserve) state.attempts++; else state.stopped = true;
      const temp = `${this.file}.new`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      fsyncDir(path.dirname(this.file));
      return true;
    } finally { fs.closeSync(lock); fs.unlinkSync(`${this.file}.lock`); }
  }
  reserve(): boolean { return this.change(true); }
  stop(): void { this.change(false); }
}
