import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { removeTestDir } from './temp-dir.test-helper.ts';
import os from 'node:os';
import path from 'node:path';
import type { ResilientLocoSession } from '@kakao-max/protocol';
import { KakaoDb } from './db.ts';
import { LocalVault, vaultMediaFileName } from './local-vault.ts';
import { collectSharedLinks, extractScheduleAndTodos } from './curation-tools.ts';
import { KakaoSession } from './kakao-session.ts';
import { loadConfig } from './config.ts';

test('collectSharedLinks categorizes URLs correctly', () => {
  const messages = [
    {
      messageId: '1',
      chatId: '100',
      authorName: 'Alice',
      text: 'Check this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ and this repo https://github.com/nodejs/node!',
      sendAt: 1700000000
    },
    {
      messageId: '2',
      chatId: '100',
      authorName: 'Bob',
      text: 'Design file: https://www.figma.com/file/xyz123 and article https://medium.com/@user/story',
      sendAt: 1700000010
    }
  ];

  const result = collectSharedLinks(messages);
  assert.equal(result.totalLinks, 4);
  assert.equal(result.categories.youtube.length, 1);
  assert.equal(result.categories.youtube[0].domain, 'www.youtube.com');
  assert.equal(result.categories.github.length, 1);
  assert.equal(result.categories.github[0].domain, 'github.com');
  assert.equal(result.categories.figma.length, 1);
  assert.equal(result.categories.article.length, 1);
});

test('extractScheduleAndTodos extracts appointments and actionable tasks', () => {
  const messages = [
    {
      messageId: '1',
      chatId: '100',
      authorName: 'Alice',
      text: '내일 오후 3시 강남역 스타벅스에서 만나요',
      sendAt: 1700000000
    },
    {
      messageId: '2',
      chatId: '100',
      authorName: 'Bob',
      text: '- [ ] 회의록 작성하기 부탁드립니다\n* [x] 배포 준비 완료',
      sendAt: 1700000010
    }
  ];

  const result = extractScheduleAndTodos(messages);
  assert.equal(result.schedules.length, 1);
  assert.ok(result.schedules[0].timeHint?.includes('오후 3시'));
  assert.equal(result.schedules[0].locationHint, '강남역 스타벅스');

  assert.equal(result.todos.length, 2);
  assert.equal(result.todos[0].completed, false);
  assert.equal(result.todos[0].task, '회의록 작성하기 부탁드립니다');
  assert.equal(result.todos[1].completed, true);
  assert.equal(result.todos[1].task, '배포 준비 완료');
});

test('LocalVault exports chat history into fixed vault/exports/ directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });

  const vault = new LocalVault(db, path.join(dir, 'vault'));
  const messages = [
    {
      messageId: '101',
      chatId: '100',
      authorId: '1',
      authorName: 'Alice',
      text: 'Hello world',
      type: 1,
      sendAt: 1700000000
    }
  ];

  // 1. JSON Export
  const jsonRes = vault.exportChatHistory('100', messages, { format: 'json' });
  assert.ok(fs.existsSync(jsonRes.exportPath));
  assert.ok(jsonRes.exportPath.startsWith(path.join(dir, 'vault', 'exports')));
  assert.equal(jsonRes.mimeType, 'application/json');
  assert.equal(jsonRes.messageCount, 1);
  const jsonContent = JSON.parse(fs.readFileSync(jsonRes.exportPath, 'utf8'));
  assert.equal(jsonContent.chatId, '100');
  assert.equal(jsonContent.messages[0].text, 'Hello world');

  // 2. HTML Export
  const htmlRes = vault.exportChatHistory('100', messages, { format: 'html', title: 'Test Room' });
  assert.ok(fs.existsSync(htmlRes.exportPath));
  assert.ok(htmlRes.exportPath.startsWith(path.join(dir, 'vault', 'exports')));
  assert.equal(htmlRes.mimeType, 'text/html');
  const htmlContent = fs.readFileSync(htmlRes.exportPath, 'utf8');
  assert.ok(htmlContent.includes('Test Room'));
  assert.ok(htmlContent.includes('Hello world'));

  // 3. Stats
  const stats = vault.getStats();
  assert.equal(stats.totalExports, 2);
  assert.equal(stats.totalMediaFiles, 0);
  assert.equal(stats.totalMediaBytes, 0);
});

test('autoSaveMessageMedia streams chunks, verifies size and checksum, and promotes to confirmed file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stream-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });

  const logs: string[] = [];
  const vault = new LocalVault(
    db,
    path.join(dir, 'vault'),
    { vaultAutoSave: true, vaultDownloadDelayMs: 0 },
    line => logs.push(line)
  );

  const testPayload = Buffer.from('hello-loco-streaming-vault-test-data');
  const sha1 = (await import('node:crypto')).createHash('sha1').update(testPayload).digest('hex');

  const fakeDownloader = async (
    _token: string,
    _type: number,
    sink: (chunk: Uint8Array, offset: number, totalExpected: number) => void | Promise<void>
  ) => {
    const chunk1 = testPayload.subarray(0, 10);
    const chunk2 = testPayload.subarray(10);
    await sink(chunk1, 0, testPayload.length);
    await sink(chunk2, 10, testPayload.length);
    return { status: 0, size: testPayload.length };
  };

  const records = await vault.autoSaveMessageMedia(
    '123456789',
    '987654321',
    2,
    { k: 'tok_abc', s: testPayload.length, cs: sha1 },
    fakeDownloader
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].chatId, '123456789');
  assert.equal(records[0].token, 'tok_abc');
  assert.equal(records[0].filesize, testPayload.length);
  assert.equal(records[0].checksum, sha1);
  assert.ok(fs.existsSync(records[0].localPath));
  assert.equal(fs.readFileSync(records[0].localPath).toString(), 'hello-loco-streaming-vault-test-data');

  // Verify temporary files are completely cleaned up
  const tmpFiles = fs.readdirSync(vault.tmpDir);
  assert.equal(tmpFiles.length, 0);

  // Verify stats are updated
  const stats = vault.getStats();
  assert.equal(stats.totalMediaFiles, 1);
  assert.equal(stats.totalMediaBytes, testPayload.length);

  // Re-saving the same item skips re-downloading
  let reDownloaded = false;
  const reRecords = await vault.autoSaveMessageMedia(
    '123456789',
    '987654321',
    2,
    { k: 'tok_abc', s: testPayload.length, cs: sha1 },
    async () => {
      reDownloaded = true;
      return { status: 0, size: testPayload.length };
    }
  );
  assert.equal(reRecords.length, 1);
  assert.equal(reDownloaded, false);
});

test('a sender-chosen file name cannot move archived media out of the room directory or overwrite another item', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-traversal-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });
  const vault = new LocalVault(db, path.join(dir, 'vault'), { vaultAutoSave: true, vaultDownloadDelayMs: 0, vaultMinFreeBytes: 0 });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  const save = (messageId: string, token: string, name: string, body: string) =>
    vault.autoSaveMessageMedia('123456789', messageId, 18, { k: token, s: body.length, name }, async (_t, _m, sink) => {
      await sink(Buffer.from(body), 0, body.length);
      return { status: 0, size: body.length };
    });

  const hostile = ['../../../victim.txt', '/etc/passwd', '..\\..\\victim.txt', '../../vault/media/other/x.txt'];
  for (const [n, name] of hostile.entries()) {
    const [record] = await save(`98765432${n}`, `tok_${n}`, name, `payload-${n}`);
    const roomDir = path.join(vault.mediaDir, '123456789');
    assert.equal(path.dirname(record.localPath), roomDir, name);
    assert.equal(record.filename, name); // original kept as metadata only
    assert.equal(fs.readFileSync(record.localPath, 'utf8'), `payload-${n}`);
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');

  // Two different files with the same display name keep separate copies.
  const [a] = await save('987654330', 'tok_a', 'photo.jpg', 'first');
  const [b] = await save('987654331', 'tok_b', 'photo.jpg', 'second');
  assert.notEqual(a.localPath, b.localPath);
  assert.equal(fs.readFileSync(a.localPath, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b.localPath, 'utf8'), 'second');
});

test('vault disk names use only numeric ids, a token hash and an allow-listed extension', () => {
  assert.match(vaultMediaFileName('987654321', 'tok', 18, 'report.PDF'), /^987654321_[0-9a-f]{16}\.pdf$/);
  assert.match(vaultMediaFileName('987654321', 'tok', 3), /^987654321_[0-9a-f]{16}\.mp4$/);
  assert.match(vaultMediaFileName('987654321', 'tok', 18, 'x.sh;rm -rf'), /^987654321_[0-9a-f]{16}$/);
  assert.match(vaultMediaFileName('987654321', '../../tok', 18, '../../.bashrc'), /^987654321_[0-9a-f]{16}$/);
  assert.throws(() => vaultMediaFileName('../1', 'tok', 2), /numeric message id/);
});

test('auto-save and export refuse non-numeric room ids instead of building paths from them', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ids-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });
  const vault = new LocalVault(db, path.join(dir, 'vault'), { vaultAutoSave: true, vaultDownloadDelayMs: 0, vaultMinFreeBytes: 0 });
  let downloads = 0;
  const records = await vault.autoSaveMessageMedia('../../escape', '987654321', 2, { k: 'tok', s: 1 }, async () => {
    downloads++;
    return { status: 0, size: 1 };
  });
  assert.deepEqual(records, []);
  assert.equal(downloads, 0);
  assert.equal(fs.existsSync(path.join(dir, 'escape')), false);
  assert.throws(() => vault.exportChatHistory('../x', [], { format: 'json' }), /numeric room id/);
});

test('autoSaveMessageMedia cleans up temp file on size or checksum mismatch without confirmed file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mismatch-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });

  const logs: string[] = [];
  const vault = new LocalVault(
    db,
    path.join(dir, 'vault'),
    { vaultAutoSave: true, vaultDownloadDelayMs: 0 },
    line => logs.push(line)
  );

  const payload = Buffer.from('corrupted-data');
  const wrongChecksum = 'ffffffffffffffffffffffffffffffffffffffff';

  const fakeDownloader = async (
    _token: string,
    _type: number,
    sink: (chunk: Uint8Array, offset: number, totalExpected: number) => void | Promise<void>
  ) => {
    await sink(payload, 0, payload.length);
    return { status: 0, size: payload.length };
  };

  const records = await vault.autoSaveMessageMedia(
    '123456555',
    '987654777',
    2,
    { k: 'tok_corrupted', s: payload.length, cs: wrongChecksum },
    fakeDownloader
  );

  assert.equal(records.length, 0);
  // No confirmed file should exist in chat dir
  const chatMediaDir = path.join(vault.mediaDir, '123456555');
  assert.equal(fs.existsSync(chatMediaDir) && fs.readdirSync(chatMediaDir).length, 0);
  // Temp files must be removed
  assert.equal(fs.readdirSync(vault.tmpDir).length, 0);

  // Failure log must NOT contain chatId, messageId, filename or contents
  assert.ok(logs.some(l => l.includes('auto-save media verification failed')));
  for (const l of logs) {
    assert.equal(l.includes('123456555'), false);
    assert.equal(l.includes('987654777'), false);
    assert.equal(l.includes('corrupted-data'), false);
    assert.equal(l.includes('tok_corrupted'), false);
  }
});

test('autoSaveMessageMedia respects vaultMaxBytes and stops download', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-limit-test-'));
  const db = KakaoDb.open({ dir });
  t.after(() => {
    db.close();
    removeTestDir(dir);
  });

  const logs: string[] = [];
  const vault = new LocalVault(
    db,
    path.join(dir, 'vault'),
    { vaultAutoSave: true, vaultMaxBytes: 50, vaultDownloadDelayMs: 0 },
    line => logs.push(line)
  );

  let downloadInvoked = false;
  const fakeDownloader = async () => {
    downloadInvoked = true;
    return { status: 0, size: 100 };
  };

  // Item announces size 100 which exceeds vaultMaxBytes (50)
  const records = await vault.autoSaveMessageMedia(
    '123456888',
    '987654321',
    2,
    { k: 'tok_large', s: 100 },
    fakeDownloader
  );

  assert.equal(records.length, 0);
  assert.equal(downloadInvoked, false);
  assert.ok(logs.some(l => l.includes('vault max bytes exceeded')));
  for (const l of logs) {
    assert.equal(l.includes('123456888'), false);
    assert.equal(l.includes('987654321'), false);
    assert.equal(l.includes('tok_large'), false);
  }
});

/** LOCO session stand-in: records media downloads and streams `body` into the caller's sink. */
class MediaFakeSession extends EventEmitter {
  isConnected = true;
  downloads: Array<{ chatId: string; opts: { timeoutMs?: number; idleTimeoutMs?: number } }> = [];
  private readonly body: Buffer;
  constructor(body: Buffer) { super(); this.body = body; }
  close() {}
  async downloadMedia(chatId: string, opts: { timeoutMs?: number; idleTimeoutMs?: number; sink?: (c: Uint8Array, o: number, t: number) => void | Promise<void> }) {
    this.downloads.push({ chatId, opts: { timeoutMs: opts.timeoutMs, idleTimeoutMs: opts.idleTimeoutMs } });
    await opts.sink?.(this.body, 0, this.body.length);
    return { status: 0, size: this.body.length, data: new Uint8Array(0) };
  }
}

function sessionWithMedia(t: { after(fn: () => void): void }, autoSave: boolean, body: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-session-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, 'KAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=fake-token\nKAKAO_REGISTERED_DEVICE_UUID=fake-uuid\n');
  const config = loadConfig({ envPath, env: {
    KAKAO_DATA_DIR: dir, KAKAO_VAULT_AUTO_SAVE: autoSave ? 'true' : 'false', KAKAO_AGENT_MODE: autoSave ? 'trust' : 'ask',
    KAKAO_VAULT_MIN_FREE_BYTES: '0', KAKAO_VAULT_DOWNLOAD_DELAY_MS: '0'
  } });
  const fake = new MediaFakeSession(body);
  const kakao = new KakaoSession(config, { session: fake as unknown as ResilientLocoSession });
  t.after(() => {
    kakao.stop();
    removeTestDir(dir);
  });
  return { fake, kakao };
}

const photoMessage = (body: Buffer) => ({
  chatId: '123456789', messageId: '1001', authorId: '555', type: 2, text: '', raw: {},
  attachment: JSON.stringify({ k: 'my_photo_token', s: body.length, name: '../../escape.jpg' }),
  sendAt: Math.floor(Date.now() / 1000)
});

test('KakaoSession does not auto-save media when vaultAutoSave is false', async t => {
  const body = Buffer.from('photo-bytes');
  const { fake } = sessionWithMedia(t, false, body);
  fake.emit('message', photoMessage(body));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fake.downloads.length, 0);
});

test('KakaoSession auto-saves inbound media with an idle timeout and no total deadline', async t => {
  const body = Buffer.from('photo-bytes');
  const { fake, kakao } = sessionWithMedia(t, true, body);
  fake.emit('message', photoMessage(body));
  for (let i = 0; i < 50 && kakao.vault.getStats().totalMediaFiles === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(fake.downloads, [{ chatId: '123456789', opts: { timeoutMs: undefined, idleTimeoutMs: 30000 } }]);
  const roomDir = path.join(kakao.vault.mediaDir, '123456789');
  const [file] = fs.readdirSync(roomDir);
  assert.match(file, /^1001_[0-9a-f]{16}\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(roomDir, file)), body);
});
