// Owner-only storage checks shared by core, MCP and CLI.
// POSIX enforces privacy with the owner uid and mode bits. Windows has neither: stat.uid is
// always 0 and mode reflects only the read-only attribute. There the per-user profile ACL
// (the default data directory lives under it) is the boundary, so only type checks apply.
import fs from 'node:fs';

const WINDOWS = process.platform === 'win32';

/** True when `stat` is owned by this process's user with no group/other access (always true on Windows). */
export function isOwnerOnly(stat: fs.Stats): boolean {
  if (WINDOWS) return true;
  return !(stat.mode & 0o077) && !!process.getuid && stat.uid === process.getuid();
}

/** Flush a directory entry after create/rename/unlink. Windows cannot fsync a directory handle; NTFS journals the metadata itself. */
export function fsyncDir(dir: string): void {
  if (WINDOWS) return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
