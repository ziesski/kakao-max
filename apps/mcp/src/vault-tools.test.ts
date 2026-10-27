import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { removeTestDir } from '../../../packages/core/src/temp-dir.test-helper.ts';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { KakaoDb, KakaoSession, loadConfig } from '@kakao-max/core';
import type { ResilientLocoSession } from '@kakao-max/protocol';
import { McpStdioServer } from './mcp-stdio.ts';
import { registerVaultTools } from './tools/vault.ts';

const CHAT_DENY = '111111111';
const CHAT_MANUAL = '222222222';
const CHAT_ALLOWED = '333333333';

/** LOCO session stand-in: every room reads as fresh with no unread messages. */
class VaultFakeSession extends EventEmitter {
  isConnected = true;
  close() {}
  async getChannelMeta(chatId: string) {
    return { chatId, raw: {}, title: 'Test Room', isGroup: false, members: [] };
  }
  async request(method: string) {
    if (method !== 'LCHATLIST') return { header: { status: 0 }, data: { status: 0 } };
    return { header: { status: 0 }, data: { chatDatas: [CHAT_MANUAL, CHAT_ALLOWED, CHAT_DENY].map(c => ({ c, n: 0, t: 'DirectChat' })) } };
  }
}

function setupVaultTest(t: { after(fn: () => void): void }, opts: { toolGroups?: ('vault')[] } = { toolGroups: ['vault'] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-test-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, 'KAKAO_USER_ID=123\nKAKAO_ACCESS_TOKEN=fake-token\nKAKAO_REGISTERED_DEVICE_UUID=fake-uuid\n');
  const config = loadConfig({
    envPath,
    env: {
      KAKAO_DATA_DIR: dir,
      KAKAO_MCP_TOOL_GROUPS: (opts.toolGroups ?? ['vault']).join(',')
    }
  });

  const fakeSession = new VaultFakeSession();
  const kakao = new KakaoSession(config, { session: fakeSession as unknown as ResilientLocoSession });
  fakeSession.emit('connected', {
    endpoint: { host: 'loco.test', port: 443 },
    loginList: {
      conversations: [
        { id: CHAT_MANUAL, type: 'DirectChat', unreadCount: 0, raw: { l: { logId: '1001' } } },
        { id: CHAT_ALLOWED, type: 'DirectChat', unreadCount: 0, raw: { l: { logId: '1002' } } },
        { id: CHAT_DENY, type: 'DirectChat', unreadCount: 0, raw: { l: { logId: '0' } } }
      ],
      raw: {}
    }
  });

  t.after(() => {
    kakao.stop();
    removeTestDir(dir);
  });

  // Seed sample messages for testing
  const now = Math.floor(Date.now() / 1000);
  const db = KakaoDb.open({ dir });
  db.db.prepare(`
    INSERT INTO messages (chat_id, message_id, author_id, author_name, type, text, send_at, seq, log_num)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CHAT_MANUAL, '1001', '501', 'Alice', 1, 'Check https://github.com/nodejs/node and meeting at 내일 오후 2시 강남역', now, 1, 1001);

  db.db.prepare(`
    INSERT INTO messages (chat_id, message_id, author_id, author_name, type, text, send_at, seq, log_num)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CHAT_ALLOWED, '1002', '502', 'Bob', 1, 'Another meeting at 내일 3시 홍대입구역', now, 2, 1002);
  db.close();

  // Set room rules
  kakao.setRoomAccess(CHAT_DENY, { mode: 'deny' });
  kakao.setRoomAccess(CHAT_MANUAL, { mode: 'manual' });
  kakao.setRoomAccess(CHAT_ALLOWED, { mode: 'manual' });

  const server = new McpStdioServer({
    name: 'test',
    version: '0.1.0',
    toolGroups: opts.toolGroups
  });

  registerVaultTools(server, kakao);

  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.end(); output.end(); });

  let id = 0, text = '';
  const pending = new Map<number, (value: any) => void>();
  output.on('data', chunk => {
    text += chunk.toString();
    let n;
    while ((n = text.indexOf('\n')) >= 0) {
      const r = JSON.parse(text.slice(0, n));
      text = text.slice(n + 1);
      pending.get(r.id)?.(r);
      pending.delete(r.id);
    }
  });
  server.serveConnection(input, output);

  const call = (name: string, args: Record<string, unknown>) => new Promise<any>(resolve => {
    const next = ++id;
    pending.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });

  const listTools = () => new Promise<any>(resolve => {
    const next = ++id;
    pending.set(next, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/list', params: {} }) + '\n');
  });

  return { call, listTools, kakao, createReadGrant: (grant: Parameters<KakaoSession['createReadGrant']>[0]) => kakao.createReadGrant(grant), dir };
}

test('vault group disabled: tools are neither listed in tools/list nor callable via tools/call', async t => {
  const h = setupVaultTest(t, { toolGroups: [] });

  const listRes = await h.listTools();
  const names = listRes.result.tools.map((t: any) => t.name);
  assert.equal(names.includes('export_chat_history'), false);
  assert.equal(names.includes('collect_shared_links'), false);
  assert.equal(names.includes('extract_schedule_and_todos'), false);
  assert.equal(names.includes('search_vault'), false);
  assert.equal(names.includes('get_vault_stats'), false);

  const callRes = await h.call('export_chat_history', { chatId: CHAT_MANUAL, format: 'json' });
  assert.equal(callRes.error?.code, -32602); // method not found / tool not registered
});

test('deny room is rejected with POLICY_DENIED', async t => {
  const h = setupVaultTest(t);

  const res = await h.call('collect_shared_links', { chatId: CHAT_DENY });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent?.error?.code, 'POLICY_DENIED');
});

test('manual room without readGrant is rejected with POLICY_DENIED', async t => {
  const h = setupVaultTest(t);

  const res = await h.call('extract_schedule_and_todos', { chatId: CHAT_MANUAL });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent?.error?.code, 'POLICY_DENIED');
});

test('grant scoped to different tool is rejected with POLICY_DENIED', async t => {
  const h = setupVaultTest(t);

  // Create a grant scoped only to read_messages
  const grant = h.createReadGrant({
    grantId: 'grant-read-messages',
    chatId: CHAT_MANUAL,
    tools: ['read_messages'],
    maxMessages: 10,
    uses: 1,
    expiresAt: Date.now() + 60000
  });

  const res = await h.call('export_chat_history', {
    chatId: CHAT_MANUAL,
    format: 'json',
    readGrantId: grant.grantId
  });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent?.error?.code, 'POLICY_DENIED');
});

test('search_vault rejects entire call if even one room is unauthorized', async t => {
  const h = setupVaultTest(t);

  // CHAT_ALLOWED has a valid grant for search_vault
  const grant = h.createReadGrant({
    grantId: 'grant-search',
    chatId: CHAT_ALLOWED,
    tools: ['search_vault'],
    maxMessages: 10,
    uses: 1,
    expiresAt: Date.now() + 60000
  });

  // But CHAT_DENY is denied
  const res = await h.call('search_vault', {
    chatIds: [CHAT_ALLOWED, CHAT_DENY],
    query: 'meeting',
    readGrantId: grant.grantId
  });

  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent?.error?.code, 'POLICY_DENIED');
  // The refusal happens before any room's budget or grant use is spent.
  assert.equal(h.kakao.listReadGrants().find(g => g.grantId === grant.grantId)?.usesLeft, 1);

  const twice = await h.call('search_vault', { chatIds: [CHAT_ALLOWED, CHAT_ALLOWED], query: 'meeting', readGrantId: grant.grantId });
  assert.equal(twice.result.structuredContent?.error?.code, 'INVALID_ARGUMENT');
});

test('valid readGrant allows execution and wraps output in untrusted envelope', async t => {
  const h = setupVaultTest(t);

  // 1. collect_shared_links
  const grantLinks = h.createReadGrant({
    grantId: 'grant-links',
    chatId: CHAT_MANUAL,
    tools: ['collect_shared_links'],
    maxMessages: 10,
    uses: 1,
    expiresAt: Date.now() + 60000
  });

  const linksRes = await h.call('collect_shared_links', {
    chatId: CHAT_MANUAL,
    readGrantId: grantLinks.grantId
  });
  assert.equal(linksRes.result.isError, false);
  const linksData = JSON.parse(linksRes.result.content[0].text);
  assert.equal(linksData.untrusted, true);
  assert.equal(linksData.totalLinks, 1);
  assert.equal(linksData.categories.github.length, 1);

  // 2. extract_schedule_and_todos
  const grantSchedule = h.createReadGrant({
    grantId: 'grant-schedule',
    chatId: CHAT_MANUAL,
    tools: ['extract_schedule_and_todos'],
    maxMessages: 10,
    uses: 1,
    expiresAt: Date.now() + 60000
  });

  const scheduleRes = await h.call('extract_schedule_and_todos', {
    chatId: CHAT_MANUAL,
    readGrantId: grantSchedule.grantId
  });
  assert.equal(scheduleRes.result.isError, false);
  const scheduleData = JSON.parse(scheduleRes.result.content[0].text);
  assert.equal(scheduleData.untrusted, true);
  assert.equal(scheduleData.schedules.length, 1);

  // 3. export_chat_history writes to dataDir/vault/exports/
  const grantExport = h.createReadGrant({
    grantId: 'grant-export',
    chatId: CHAT_MANUAL,
    tools: ['export_chat_history'],
    maxMessages: 10,
    uses: 1,
    expiresAt: Date.now() + 60000
  });

  const exportRes = await h.call('export_chat_history', {
    chatId: CHAT_MANUAL,
    format: 'json',
    readGrantId: grantExport.grantId
  });
  assert.equal(exportRes.result.isError, false);
  const exportData = JSON.parse(exportRes.result.content[0].text);
  assert.equal(exportData.untrusted, true);
  assert.ok(exportData.exportPath.startsWith(path.join(h.dir, 'vault', 'exports')));
  assert.ok(fs.existsSync(exportData.exportPath));

  // 4. get_vault_stats returns stats without private content
  const statsRes = await h.call('get_vault_stats', {});
  assert.equal(statsRes.result.isError, false);
  const statsData = JSON.parse(statsRes.result.content[0].text);
  assert.equal(statsData.totalExports, 1);
  assert.equal(statsData.totalMediaFiles, 0);
  assert.equal(statsData.chatId, undefined);
  assert.equal(statsData.text, undefined);
});
