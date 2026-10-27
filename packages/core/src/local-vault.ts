// ----------------------------------------------------------------------------
// Local Vault: 100% private KakaoTalk local export, curation & media vault.
//
// Provides lifetime HTML/JSON export, media preservation and search helpers.
// All content access is gated by RoomAccessPolicy in KakaoSession before reaching here.
// ----------------------------------------------------------------------------

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KakaoDb } from './db.ts';
import { KakaoError } from './errors.ts';

/** Room and message ids are server numbers; anything else must never reach a path. */
const NUMERIC_ID = /^-?\d{1,20}$/;
const TYPE_EXT: Record<number, string> = { 2: '.jpg', 3: '.mp4', 5: '.m4a', 27: '.jpg' };

/**
 * Disk name for one archived item. Built only from validated ids, a token hash and an allow-listed
 * extension: the sender-chosen attachment name is metadata only, so `../` or `/` in it cannot move
 * the file out of the room directory or overwrite another item.
 */
export function vaultMediaFileName(messageId: string, token: string, mediaType: number, originalName?: string): string {
  if (!NUMERIC_ID.test(messageId)) throw new KakaoError('INVALID_ARGUMENT', 'Vault media needs a numeric message id');
  const fromName = originalName ? path.extname(path.basename(originalName.replace(/\\/g, '/'))).toLowerCase() : '';
  const ext = TYPE_EXT[mediaType] ?? (/^\.[a-z0-9]{1,8}$/.test(fromName) ? fromName : '');
  return `${messageId}_${createHash('sha256').update(token).digest('hex').slice(0, 16)}${ext}`;
}

/** `child` resolved inside `dir`, or an error. Defense in depth behind the name rules above. */
function inside(dir: string, child: string): string {
  const full = path.resolve(dir, child);
  const rel = path.relative(path.resolve(dir), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new KakaoError('INVALID_ARGUMENT', 'Vault path escapes its directory');
  return full;
}

export interface VaultStats {
  totalMediaFiles: number;
  totalMediaBytes: number;
  totalExports: number;
  vaultDir: string;
}

export interface ExportChatResult {
  exportPath: string;
  filename: string;
  mimeType: string;
  messageCount: number;
}

export interface ExtractedMediaItem {
  token: string;
  size?: number;
  checksum?: string;
  filename?: string;
  mediaType: number;
}

export interface VaultMediaRecord {
  id?: number;
  chatId: string;
  messageId: string;
  mediaType: number;
  token: string;
  filename?: string;
  filesize?: number;
  checksum?: string;
  localPath: string;
  savedAt: number;
  createdAt?: number;
}

export class LocalVault {
  readonly kdb: KakaoDb;
  readonly vaultDir: string;
  readonly mediaDir: string;
  readonly exportDir: string;
  readonly tmpDir: string;
  private readonly config?: {
    vaultAutoSave?: boolean;
    vaultMaxBytes?: number;
    vaultMinFreeBytes?: number;
    vaultDownloadDelayMs?: number;
  };
  private readonly log?: (msg: string) => void;
  private downloadQueue: Promise<void> = Promise.resolve();

  constructor(
    kdb: KakaoDb,
    vaultDir?: string,
    config?: {
      vaultAutoSave?: boolean;
      vaultMaxBytes?: number;
      vaultMinFreeBytes?: number;
      vaultDownloadDelayMs?: number;
    },
    log?: (msg: string) => void
  ) {
    this.kdb = kdb;
    const baseDir = vaultDir ?? path.join(path.dirname(kdb.path), 'vault');
    this.vaultDir = baseDir;
    this.mediaDir = path.join(baseDir, 'media');
    this.exportDir = path.join(baseDir, 'exports');
    this.tmpDir = path.join(baseDir, 'tmp');
    this.config = config;
    this.log = log;

    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.exportDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.vaultDir, 0o700);
      fs.chmodSync(this.mediaDir, 0o700);
      fs.chmodSync(this.exportDir, 0o700);
      fs.chmodSync(this.tmpDir, 0o700);
    } catch {
      // Best-effort permission setting on POSIX systems
    }
  }

  /**
   * Return high-level storage stats without any private message content or room titles.
   */
  getStats(): VaultStats {
    let totalMediaFiles = 0;
    let totalMediaBytes = 0;
    try {
      const row = this.kdb.db.prepare(
        'SELECT COUNT(*) as count, COALESCE(SUM(filesize), 0) as bytes FROM vault_media'
      ).get() as { count: number; bytes: number } | undefined;
      totalMediaFiles = Number(row?.count ?? 0);
      totalMediaBytes = Number(row?.bytes ?? 0);
    } catch {
      try {
        if (fs.existsSync(this.mediaDir)) {
          const scan = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) scan(full);
              else if (ent.isFile() && !ent.name.startsWith('.')) {
                totalMediaFiles++;
                try { totalMediaBytes += fs.statSync(full).size; } catch {}
              }
            }
          };
          scan(this.mediaDir);
        }
      } catch {}
    }

    let totalExports = 0;
    try {
      if (fs.existsSync(this.exportDir)) {
        totalExports = fs.readdirSync(this.exportDir).filter((f) => !f.startsWith('.')).length;
      }
    } catch {
      // ignore read error
    }

    return {
      totalMediaFiles,
      totalMediaBytes,
      totalExports,
      vaultDir: this.vaultDir
    };
  }

  /**
   * Export authorized messages to an immutable file inside vault/exports/.
   * Destination path is fixed under dataDir/vault/exports/ and cannot be chosen by callers.
   */
  exportChatHistory(
    chatId: string,
    messages: Array<{
      messageId: string;
      chatId: string;
      authorId: string;
      authorName?: string;
      text: string;
      type: number;
      sendAt: number;
    }>,
    opts: { format: 'json' | 'html'; title?: string }
  ): ExportChatResult {
    if (!NUMERIC_ID.test(chatId)) throw new KakaoError('INVALID_ARGUMENT', 'Export needs a numeric room id');
    const chatTitle = opts.title ?? `Chat_${chatId}`;
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    if (opts.format === 'json') {
      const filename = `kakao-vault-${chatId}-${timestampStr}.json`;
      const exportPath = path.join(this.exportDir, filename);
      const jsonContent = JSON.stringify({
        chatId,
        title: chatTitle,
        exportedAt: new Date().toISOString(),
        totalMessages: messages.length,
        messages
      }, null, 2);

      fs.writeFileSync(exportPath, jsonContent, { mode: 0o600 });
      return {
        exportPath,
        filename,
        mimeType: 'application/json',
        messageCount: messages.length
      };
    }

    // HTML export
    const filename = `kakao-vault-${chatId}-${timestampStr}.html`;
    const exportPath = path.join(this.exportDir, filename);
    const htmlContent = this.renderHtmlChatBook(chatId, chatTitle, messages);

    fs.writeFileSync(exportPath, htmlContent, { mode: 0o600 });
    return {
      exportPath,
      filename,
      mimeType: 'text/html',
      messageCount: messages.length
    };
  }

  private renderHtmlChatBook(
    chatId: string,
    title: string,
    rows: Array<{
      messageId: string;
      authorId: string;
      authorName?: string;
      text: string;
      type: number;
      sendAt: number;
    }>
  ): string {
    const escapeHtml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const messageHtmls: string[] = [];
    let lastDate = '';

    for (const r of rows) {
      const dateObj = new Date(r.sendAt * 1000);
      const dateStr = dateObj.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
      const timeStr = dateObj.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

      if (dateStr !== lastDate) {
        lastDate = dateStr;
        messageHtmls.push(`<div class="date-divider"><span>${escapeHtml(dateStr)}</span></div>`);
      }

      const author = escapeHtml(r.authorName || `User ${r.authorId}`);
      const body = escapeHtml(r.text || '').replace(/\n/g, '<br/>');

      messageHtmls.push(`
        <div class="message-row">
          <div class="author">${author}</div>
          <div class="bubble">
            <div class="text">${body}</div>
            <div class="time">${escapeHtml(timeStr)}</div>
          </div>
        </div>
      `);
    }

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - KakaoTalk Archive</title>
  <style>
    :root {
      --bg-color: #f7f7f8;
      --chat-bg: #b2c7da;
      --bubble-other: #ffffff;
      --text-main: #1e1e1e;
      --text-sub: #666666;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-color); margin: 0; padding: 20px; }
    .chat-container { max-width: 800px; margin: 0 auto; background: var(--chat-bg); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
    .header { background: #3c4043; color: white; padding: 16px 20px; font-size: 1.2rem; font-weight: bold; }
    .messages-viewport { padding: 20px; min-height: 400px; display: flex; flex-direction: column; gap: 12px; }
    .date-divider { text-align: center; margin: 16px 0; }
    .date-divider span { background: rgba(0,0,0,0.2); color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.8rem; }
    .message-row { display: flex; flex-direction: column; align-items: flex-start; }
    .author { font-size: 0.8rem; color: var(--text-sub); margin-bottom: 4px; margin-left: 4px; }
    .bubble { background: var(--bubble-other); color: var(--text-main); padding: 8px 12px; border-radius: 8px; max-width: 70%; word-break: break-word; font-size: 0.95rem; }
    .time { font-size: 0.7rem; color: var(--text-sub); text-align: right; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="header">${escapeHtml(title)}</div>
    <div class="messages-viewport">
      ${messageHtmls.join('\n')}
    </div>
  </div>
</body>
</html>`;
  }

  /** Extract media tokens and metadata from a message attachment. */
  extractMediaTokens(type: number, attachmentRaw: string | Record<string, unknown> | null | undefined): ExtractedMediaItem[] {
    if (attachmentRaw == null) return [];
    let att: Record<string, unknown>;
    if (typeof attachmentRaw === 'string') {
      try {
        att = JSON.parse(attachmentRaw);
      } catch {
        return [];
      }
    } else if (typeof attachmentRaw === 'object' && attachmentRaw !== null) {
      att = attachmentRaw;
    } else {
      return [];
    }

    const items: ExtractedMediaItem[] = [];

    // Type 27: Multi-photo bundle
    if (type === 27 && Array.isArray(att.kl)) {
      const tokens = att.kl as unknown[];
      const sizes = Array.isArray(att.sl) ? (att.sl as unknown[]) : [];
      const checksums = Array.isArray(att.csl) ? (att.csl as unknown[]) : [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (typeof token === 'string' && token.length > 0) {
          items.push({
            token,
            size: typeof sizes[i] === 'number' ? Number(sizes[i]) : undefined,
            checksum: typeof checksums[i] === 'string' ? String(checksums[i]) : undefined,
            mediaType: 2
          });
        }
      }
      return items;
    }

    // Type 3: Video
    if (type === 3) {
      const token = typeof att.tk === 'string' ? att.tk : typeof att.k === 'string' ? att.k : undefined;
      if (token) {
        items.push({
          token,
          size: typeof att.s === 'number' ? att.s : typeof att.size === 'number' ? att.size : undefined,
          checksum: typeof att.cs === 'string' ? att.cs : undefined,
          mediaType: 3
        });
      }
      return items;
    }

    // Type 2 (Photo), Type 5 (Audio), Type 18 (File)
    const token = typeof att.k === 'string' ? att.k : typeof att.tk === 'string' ? att.tk : undefined;
    if (token) {
      items.push({
        token,
        size: typeof att.s === 'number' ? att.s : typeof att.size === 'number' ? att.size : undefined,
        checksum: typeof att.cs === 'string' ? att.cs : undefined,
        filename: typeof att.name === 'string' ? att.name : undefined,
        mediaType: type
      });
    }

    return items;
  }

  saveMediaRecord(record: {
    chatId: string;
    messageId: string;
    mediaType: number;
    token: string;
    filename?: string;
    filesize?: number;
    checksum?: string;
    localPath: string;
    savedAt?: number;
  }): VaultMediaRecord {
    const now = Math.floor(Date.now() / 1000);
    const savedAt = record.savedAt ?? now;

    this.kdb.db.prepare(`
      INSERT INTO vault_media (
        chat_id, message_id, media_type, token, filename, filesize, checksum, local_path, saved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, token) DO UPDATE SET
        message_id = excluded.message_id,
        filename = coalesce(excluded.filename, vault_media.filename),
        filesize = coalesce(excluded.filesize, vault_media.filesize),
        checksum = coalesce(excluded.checksum, vault_media.checksum),
        local_path = excluded.local_path,
        saved_at = excluded.saved_at
    `).run(
      record.chatId,
      record.messageId,
      record.mediaType,
      record.token,
      record.filename ?? null,
      record.filesize ?? null,
      record.checksum ?? null,
      record.localPath,
      savedAt,
      now
    );

    return this.getMediaRecord(record.chatId, record.token)!;
  }

  getMediaRecord(chatId: string, token: string): VaultMediaRecord | undefined {
    const row = this.kdb.db.prepare(
      'SELECT * FROM vault_media WHERE chat_id = ? AND token = ?'
    ).get(chatId, token) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  listMedia(opts: { chatId?: string; mediaType?: number; limit?: number } = {}): VaultMediaRecord[] {
    const limit = opts.limit ?? 100;
    let query = 'SELECT * FROM vault_media';
    const params: Array<string | number | null> = [];
    const conditions: string[] = [];

    if (opts.chatId) {
      conditions.push('chat_id = ?');
      params.push(opts.chatId);
    }
    if (opts.mediaType !== undefined) {
      conditions.push('media_type = ?');
      params.push(opts.mediaType);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY saved_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.kdb.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): VaultMediaRecord {
    return {
      id: Number(row.id),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      mediaType: Number(row.media_type),
      token: String(row.token),
      filename: row.filename ? String(row.filename) : undefined,
      filesize: row.filesize != null ? Number(row.filesize) : undefined,
      checksum: row.checksum ? String(row.checksum) : undefined,
      localPath: String(row.local_path),
      savedAt: Number(row.saved_at),
      createdAt: Number(row.created_at)
    };
  }

  /**
   * Streamingly download expiring media items into temporary files, verify announced size and
   * checksum, and atomically promote them into permanent vault media storage.
   * Gated strictly by loadConfig() flags and storage limits (no agent-chosen paths).
   */
  async autoSaveMessageMedia(
    chatId: string,
    messageId: string,
    type: number,
    attachment: string | Record<string, unknown> | null | undefined,
    downloader: (
      token: string,
      mediaType: number,
      sink: (chunk: Uint8Array, offset: number, totalExpected: number) => void | Promise<void>
    ) => Promise<{ status: number; size: number }>
  ): Promise<VaultMediaRecord[]> {
    return new Promise((resolve) => {
      this.downloadQueue = this.downloadQueue.then(async () => {
        try {
          const res = await this.doAutoSaveMessageMedia(chatId, messageId, type, attachment, downloader);
          resolve(res);
        } catch (e) {
          // One failed item must not stall the queue for later messages. Log the error kind only:
          // messages can carry paths, ids or names that do not belong in service logs.
          this.log?.(`[vault] auto-save failed: ${e instanceof KakaoError ? e.code : (e as Error)?.name ?? 'error'}`);
          resolve([]);
        }
      });
    });
  }

  private async doAutoSaveMessageMedia(
    chatId: string,
    messageId: string,
    type: number,
    attachment: string | Record<string, unknown> | null | undefined,
    downloader: (
      token: string,
      mediaType: number,
      sink: (chunk: Uint8Array, offset: number, totalExpected: number) => void | Promise<void>
    ) => Promise<{ status: number; size: number }>
  ): Promise<VaultMediaRecord[]> {
    const items = this.extractMediaTokens(type, attachment);
    if (items.length === 0) return [];

    // 1. Check disk space limits
    try {
      const stat = fs.statfsSync(this.vaultDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const minFree = this.config?.vaultMinFreeBytes ?? 500 * 1024 * 1024;
      if (freeBytes < minFree) {
        this.log?.('[vault] auto-save skipped: disk free space below minimum threshold');
        return [];
      }
    } catch {
      // Best-effort check if statfs is unavailable
    }

    if (this.config?.vaultMaxBytes !== undefined) {
      const stats = this.getStats();
      if (stats.totalMediaBytes >= this.config.vaultMaxBytes) {
        this.log?.('[vault] auto-save skipped: vault max bytes exceeded');
        return [];
      }
    }

    if (!NUMERIC_ID.test(chatId) || !NUMERIC_ID.test(messageId)) {
      this.log?.('[vault] auto-save skipped: non-numeric room or message id');
      return [];
    }
    const chatMediaDir = inside(this.mediaDir, chatId);
    fs.mkdirSync(chatMediaDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });

    const saved: VaultMediaRecord[] = [];

    for (const item of items) {
      const existing = this.getMediaRecord(chatId, item.token);
      if (existing && fs.existsSync(existing.localPath)) {
        saved.push(existing);
        continue;
      }

      if (this.config?.vaultMaxBytes !== undefined && item.size !== undefined) {
        const stats = this.getStats();
        if (stats.totalMediaBytes + item.size > this.config.vaultMaxBytes) {
          this.log?.('[vault] auto-save skipped: vault max bytes exceeded');
          continue;
        }
      }

      const tmpFileName = `.tmp_${randomUUID()}`;
      const tmpFilePath = path.join(this.tmpDir, tmpFileName);
      const outStream = fs.createWriteStream(tmpFilePath, { mode: 0o600 });
      const hash = createHash('sha1');
      let bytesWritten = 0;

      const sink = async (chunk: Uint8Array) => {
        bytesWritten += chunk.length;
        hash.update(chunk);
        if (!outStream.write(Buffer.from(chunk))) {
          await new Promise<void>((r) => outStream.once('drain', r));
        }
      };

      let downloadOk = false;
      try {
        const res = await downloader(item.token, item.mediaType, sink);
        await new Promise<void>((resolve, reject) => {
          outStream.end(() => resolve());
          outStream.on('error', reject);
        });

        if (res.status === 0) {
          const digest = hash.digest('hex');
          const sizeMatches = item.size === undefined || bytesWritten === item.size;
          const checksumMatches = !item.checksum || digest.toLowerCase() === item.checksum.toLowerCase();

          if (sizeMatches && checksumMatches) {
            // The sender's attachment name is kept as metadata only; the disk name never uses it.
            const finalPath = inside(chatMediaDir, vaultMediaFileName(messageId, item.token, item.mediaType, item.filename));

            // Atomically confirm file. The name is unique per message and token, so this replaces at
            // most a stale copy of the same item (e.g. a crash between rename and the record write).
            fs.renameSync(tmpFilePath, finalPath);
            downloadOk = true;
            try { fs.chmodSync(finalPath, 0o600); } catch {}

            const record = this.saveMediaRecord({
              chatId,
              messageId,
              mediaType: item.mediaType,
              token: item.token,
              filename: item.filename ?? path.basename(finalPath),
              filesize: bytesWritten,
              checksum: digest,
              localPath: finalPath
            });
            saved.push(record);
          } else {
            this.log?.('[vault] auto-save media verification failed: size or checksum mismatch');
          }
        } else {
          this.log?.('[vault] auto-save media download returned non-zero status');
        }
      } catch {
        this.log?.('[vault] auto-save media download failed');
      } finally {
        if (!downloadOk) {
          try {
            if (fs.existsSync(tmpFilePath)) {
              fs.unlinkSync(tmpFilePath);
            }
          } catch {
            // best-effort cleanup
          }
        }
      }

      const delayMs = this.config?.vaultDownloadDelayMs ?? 1000;
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    return saved;
  }
}
