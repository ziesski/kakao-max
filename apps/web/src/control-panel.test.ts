// The control panel's routes against the daemon's real permission tools, approval engine and
// client-dialog approvals, with a fixture account in a temporary directory (never Kakao).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgentOperationEngine, AGENT_CONTROL_DEFINITIONS, AgentSendJournal, ApprovalStore, ApproverRegistry, DailyActionLimit, KakaoDb, RecipientPermissions, RoomAccessPolicy, SendPolicy, loadConfig } from '@kakao-max/core';
import { McpStdioServer } from '../../mcp/src/mcp-stdio.ts';
import { ElicitationApprovals } from '../../mcp/src/client-approval.ts';
import { agentControlAdapter, grantViews, registerPermissionTools } from '../../mcp/src/tools/agent-operations.ts';
import { registerCoreReadTools } from '../../mcp/src/tools/core-read.ts';
import { McpBridge, type ApprovalDialog } from './mcp-bridge.ts';
import { controlRoute, isPermissionId, permissionItems } from './control-panel.ts';

const ROOM = '700000001', OTHER = '700000002';
const RESUME = '00000000-0000-4000-8000-0000000000a1';

async function daemon(t: { after(fn: () => unknown): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-max-web-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = KakaoDb.open({ dir: root }), journal = AgentSendJournal.open(root), rooms = new RoomAccessPolicy(db);
  const approvals = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  const policy = new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(root, 'audit') });
  const account = { getState: () => ({ connected: true, userId: '900000001' }), selfUserId: '900000001',
    listChats: () => [{ id: ROOM, title: 'fixture room', type: 'MultiChat', memberCount: 2, unreadCount: 0 }],
    getRoomAccess: (id: string) => ({ rule: rooms.rule(id) }), setRoomAccess: (id: string, rule: unknown) => rooms.set(id, rule),
    listRoomAccess: () => rooms.listRules(), tightenRoomAccess: (id: string, rule: unknown) => rooms.tighten(id, rule),
    listReadGrants: () => rooms.listReadGrants(), revokeReadGrant: (id: string) => rooms.revokeReadGrant(id) };
  const engine = new AgentOperationEngine({ principal: 'local-mcp', journal, definitions: AGENT_CONTROL_DEFINITIONS, approvals,
    adapter: agentControlAdapter(account as never, policy, recipients, new DailyActionLimit(journal.db, { action: 'add_friend', limit: 10, timeZone: 'UTC' })), rateLimit: () => policy.describe().rateLimit });
  const server = new McpStdioServer({ name: 'control-fixture', version: '0' });
  server.setClientApproval(new ElicitationApprovals(approvals, Date.now, recipients));
  const views = grantViews(account as never, recipients);
  registerPermissionTools(server, { engine: () => engine, grants: () => views, policy });
  registerCoreReadTools(server, { kakao: account as never, policy, config: loadConfig({ env: { KAKAO_DATA_DIR: root }, envPath: path.join(root, '.env.local') }), groups: [], grants: () => views });
  // Fixture permissions the person granted earlier.
  recipients.grant(ROOM, 'fixture');
  rooms.set(OTHER, { mode: 'immediate' });
  const listener = net.createServer(socket => server.serveConnection(socket, socket));
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const bridge = new McpBridge({ port: (listener.address() as net.AddressInfo).port });
  bridge.on('error', () => {});
  t.after(() => { bridge.close(); return new Promise<void>(resolve => listener.close(() => resolve())); });
  await bridge.connect();
  return { bridge, policy, recipients, rooms };
}

const route = (bridge: McpBridge, p: string, method: string, body?: unknown) => controlRoute(p, method, body, bridge, () => bridge.pendingApprovalIds());

test('the panel shows connection, agent mode (display only), pause and every permission', async t => {
  const { bridge } = await daemon(t);
  const r = await route(bridge, '/api/control', 'GET');
  const body = r!.body as any;
  assert.equal(r!.status, 200);
  assert.deepEqual(body.status.agentMode, { mode: 'ask', source: 'default' });
  assert.equal(body.status.paused, false); assert.equal(body.status.connected, true);
  assert.equal('auditLogPath' in body.status, false, 'only the fields the panel shows reach the page');
  assert.deepEqual(body.permissions.map((p: any) => [p.kind, p.permissionId]), [['send', `recipient:${ROOM}`], ['read-rule', `room:${OTHER}`]]);
  // Nothing in the panel's API can change the mode.
  for (const p of ['/api/control/mode', '/api/control/agent-mode']) assert.equal(await route(bridge, p, 'POST', { mode: 'trust' }), undefined);
});

test('revoking a permission applies at once and the list follows', async t => {
  const { bridge, recipients, rooms } = await daemon(t);
  assert.deepEqual((await route(bridge, '/api/control/revoke', 'POST', { permissionId: `recipient:${ROOM}` }))!.body, { permissionId: `recipient:${ROOM}`, revoked: true });
  assert.equal((await route(bridge, '/api/control/revoke', 'POST', { permissionId: `room:${OTHER}` }))!.status, 200);
  assert.equal(recipients.list().length, 0); assert.equal(rooms.rule(OTHER).mode, 'deny');
  assert.deepEqual(((await route(bridge, '/api/control', 'GET'))!.body as any).permissions, []);
  for (const bad of [undefined, '', 'recipient:', 'recipient:1;rm', 'all', `room:${OTHER}\n`]) {
    assert.equal((await route(bridge, '/api/control/revoke', 'POST', { permissionId: bad }))!.status, 400, String(bad));
  }
});

test('pause applies at once; the pause route cannot release it', async t => {
  const { bridge, policy } = await daemon(t);
  assert.equal((await route(bridge, '/api/control/pause', 'POST', { paused: false }))!.status, 400);
  assert.deepEqual((await route(bridge, '/api/control/pause', 'POST', { paused: true }))!.body, { paused: true });
  assert.equal(policy.isPaused(), true);
  assert.equal(((await route(bridge, '/api/control', 'GET'))!.body as any).status.paused, true);
});

test('releasing a pause waits for the code the person types in the relayed dialog', async t => {
  const { bridge, policy } = await daemon(t);
  policy.setPaused(true);
  assert.equal((await route(bridge, '/api/control/resume', 'POST', {}))!.status, 400, 'a requestId is required');
  const seen: ApprovalDialog[] = [];
  bridge.on('approval', (d: ApprovalDialog) => {
    seen.push(d);
    // The person reads the code in the dialog and types it; the GUI never fills it in.
    const code = /확인 코드 ([A-Z2-9]{4})/.exec(d.message)![1];
    bridge.answerApproval(d.id, { action: 'accept', code, remember: false });
  });
  const r = await route(bridge, '/api/control/resume', 'POST', { requestId: RESUME });
  assert.equal(seen.length, 1, 'the daemon asked through the relayed dialog');
  assert.deepEqual(r!.body, { paused: false }); assert.equal(policy.isPaused(), false);
});

test('a declined or unanswered release keeps the pause', async t => {
  const { bridge, policy } = await daemon(t);
  policy.setPaused(true);
  bridge.on('approval', (d: ApprovalDialog) => bridge.answerApproval(d.id, { action: 'decline' }));
  const declined = await route(bridge, '/api/control/resume', 'POST', { requestId: RESUME });
  assert.equal((declined!.body as any).code, 'POLICY_DENIED'); assert.equal((declined!.body as any).uncertain, false);
  assert.equal(policy.isPaused(), true);
  bridge.removeAllListeners('approval');
  // No page to show the dialog: it is cancelled at once, nothing is approved.
  const unanswered = await route(bridge, '/api/control/resume', 'POST', { requestId: '00000000-0000-4000-8000-0000000000a2' });
  assert.equal((unanswered!.body as any).code, 'APPROVAL_REQUIRED');
  assert.equal(policy.isPaused(), true);
});

test('a disconnected daemon is reported, never guessed', async t => {
  const { bridge } = await daemon(t);
  bridge.close();
  const r = await route(bridge, '/api/control', 'GET');
  assert.equal((r!.body as any).status.connected, false); assert.equal((r!.body as any).status.paused, null);
  assert.equal((await route(bridge, '/api/control/pause', 'POST', { paused: true }))!.status, 503);
});

test('permission ids and list shapes', () => {
  assert.equal(isPermissionId('recipient:700000001'), true); assert.equal(isPermissionId('00000000-0000-4000-8000-000000000001'), true);
  assert.equal(isPermissionId('recipient:7 0'), false);
  const items = permissionItems({ readGrants: [{ grantId: 'g', chatId: '1', usesLeft: 1, expiresAt: 0, revoked: true }, { grantId: 'h', chatId: '1', usesLeft: 1 }], sendRooms: [{}] });
  assert.deepEqual(items.map(i => i.permissionId), ['h'], 'revoked or malformed entries are not offered');
});
