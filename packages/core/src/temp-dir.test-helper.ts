// Temp-dir cleanup for tests whose KakaoSession/MessageStore keeps its SQLite handle open until exit.
// Windows refuses to unlink an open file (EBUSY/EPERM); the OS temp cleaner removes what is left there.
import fs from 'node:fs';

export function removeTestDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
  }
}
