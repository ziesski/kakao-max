import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { AgentSendJournal, AgentSendService, ApprovalStore, ApproverRegistry, RecipientPermissions, SendPolicy, approvalChallenge } from '@kakao-max/core';
import { ApprovalCenter } from './approval-center.ts';
import { createApprovalServer } from './approval-server.ts';
import { createEnrollment, enrollmentFile } from './enrollment.ts';
import { fixtureAuthenticator } from '../../../packages/core/src/webauthn-fixture.test-helper.ts';

const ORIGIN = 'http://localhost:8788';
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function harness(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-server-'));
  const journal = AgentSendJournal.open(root), registry = new ApproverRegistry(root), store = new ApprovalStore(journal, registry);
  const notices: string[] = [];
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'Asia/Seoul' });
  const center = new ApprovalCenter({ store, origin: ORIGIN, notify: async text => { notices.push(text); }, notifyDelayMs: 60_000, recipients });
  let sends = 0;
  const service = new AgentSendService({ principal: 'local-mcp', journal, approvals: store,
    policy: new SendPolicy({ ceiling: ['123456789'], pausedAtStart: false, auditLogPath: path.join(root, 'audit') }),
    adapter: { accountId: () => '987654321', connected: () => true, context: () => 'fixture', send: async () => { sends++; return { status: 0, logId: '9007199254740993' }; } } });
  const server = createApprovalServer({ center, registry, origin: ORIGIN, dataDir: root, listen: '127.0.0.1:8788' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(() => { server.close(); center.close(); journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = (method: string, p: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any }>((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'localhost:8788',
        ...(payload ? { 'content-type': 'application/json', origin: ORIGIN } : {}), ...opts.headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { const body = Buffer.concat(chunks); let json; try { json = JSON.parse(body.toString()); } catch { json = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body, json }); });
      });
      req.on('error', reject); if (payload) req.write(payload); req.end();
    });
  return { root, registry, store, center, service, notices, request, recipients, sends: () => sends };
}

async function enroll(h: Awaited<ReturnType<typeof harness>>) {
  const device = fixtureAuthenticator(), { code } = createEnrollment(h.root);
  const options = await h.request('POST', '/api/enroll/options', { body: { code } });
  assert.equal(options.status, 200);
  const registration = device.register(Buffer.from(options.json.challenge, 'base64url'), ORIGIN);
  const done = await h.request('POST', '/api/enroll', { body: { code, label: 'fixture phone', ...registration } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return device;
}

test('enrollment needs the terminal code, the exact origin and user verification, and is single-use', async t => {
  const h = await harness(t), device = fixtureAuthenticator(), { code } = createEnrollment(h.root);
  if (process.platform !== 'win32') assert.equal(fs.statSync(enrollmentFile(h.root)).mode & 0o777, 0o600);
  assert.equal((await h.request('POST', '/api/enroll/options', { body: { code }, headers: { origin: 'https://evil.example.test' } })).status, 403);
  assert.equal((await h.request('POST', '/api/enroll/options', { body: { code: 'WRONG-CODE0' } })).json.error, 'APPROVAL_REQUIRED');
  const options = await h.request('POST', '/api/enroll/options', { body: { code } });
  const challenge = Buffer.from(options.json.challenge, 'base64url');
  const noUv = await h.request('POST', '/api/enroll', { body: { code, label: 'x', ...device.register(challenge, ORIGIN, { flags: 0x41 }) } });
  assert.equal(noUv.status, 403); assert.equal(h.registry.list().length, 0);
  assert.equal((await h.request('POST', '/api/enroll', { body: { code, label: 'fixture phone', ...device.register(challenge, ORIGIN) } })).status, 200);
  assert.equal(h.registry.list().length, 1); assert.equal(fs.existsSync(enrollmentFile(h.root)), false);
  assert.equal((await h.request('POST', '/api/enroll/options', { body: { code } })).status, 403);
});

test('wrong guesses exhaust an enrollment code', async t => {
  const h = await harness(t), { code } = createEnrollment(h.root);
  for (let i = 0; i < 5; i++) await h.request('POST', '/api/enroll/options', { body: { code: `GUESS-${i}AAAA` } });
  assert.equal((await h.request('POST', '/api/enroll/options', { body: { code } })).status, 403);
});

test('a prepared send is approved on the page with a passkey, notified without content, and then commits without a signature', async t => {
  const h = await harness(t), device = await enroll(h);
  const id = randomUUID(), message = { chatId: '123456789', text: 'fixture 초안\u202Egnp.exe' };
  const prepared = h.service.prepare(id, message);
  const offer = h.center.offer(prepared) as { approvalUrl: string; code: string };
  assert.match(offer.approvalUrl, new RegExp(`^${ORIGIN}/a/${id}#[A-Za-z0-9_-]{24}$`));
  await h.center.flush();
  assert.equal(h.notices.length, 1); assert.ok(h.notices[0].includes(offer.code)); assert.ok(h.notices[0].includes(offer.approvalUrl));
  assert.equal(h.notices[0].includes('fixture'), false);

  const token = offer.approvalUrl.split('#')[1], api = `/api/approvals/${id}`;
  assert.equal((await h.request('GET', api)).status, 404);
  assert.equal((await h.request('GET', api, { headers: { 'x-approval-token': token.slice(1) + 'A' } })).status, 404);
  assert.equal((await h.request('GET', api, { headers: { 'x-approval-token': token, host: 'attacker.example.test' } })).status, 421);
  const view = await h.request('GET', api, { headers: { 'x-approval-token': token } });
  assert.equal(view.status, 200); assert.equal(view.json.envelope.message.text, message.text);
  assert.match(String(view.headers['content-security-policy']), /script-src 'self'/);
  assert.deepEqual(view.json.allowCredentials, [device.credentialId]);
  assert.equal(view.json.challenge, approvalChallenge(prepared.signingText).toString('base64url'));

  assert.equal((await h.center.wait(id, 10)).state, 'awaiting_approval');
  const waiting = h.center.wait(id, 5000);
  const challenge = Buffer.from(view.json.challenge, 'base64url');
  const noUv = await h.request('POST', `${api}/approve`, { headers: { 'x-approval-token': token }, body: device.assert(challenge, ORIGIN, { flags: 0x01 }) });
  assert.equal(noUv.status, 403);
  const crossSite = await h.request('POST', `${api}/approve`, { headers: { 'x-approval-token': token, origin: 'https://evil.example.test' }, body: device.assert(challenge, ORIGIN) });
  assert.equal(crossSite.status, 403);
  assert.equal(h.sends(), 0);
  const ok = await h.request('POST', `${api}/approve`, { headers: { 'x-approval-token': token }, body: device.assert(challenge, ORIGIN) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await waiting).state, 'approved');
  assert.equal((await h.request('GET', api, { headers: { 'x-approval-token': token } })).status, 404); // consumed: draft dropped from memory
  assert.equal((await h.service.send(id, message)).state, 'sent_unverified'); assert.equal(h.sends(), 1);
});

test('rejection on the page is final, and previews show only bytes matching the signed digest', async t => {
  const h = await harness(t); await enroll(h);
  const id = randomUUID(), message = { chatId: '123456789', text: 'fixture rejected' };
  const offer = h.center.offer(h.service.prepare(id, message)) as { approvalUrl: string };
  const token = offer.approvalUrl.split('#')[1];
  assert.equal((await h.request('POST', `/api/approvals/${id}/reject`, { headers: { 'x-approval-token': token }, body: {} })).status, 200);
  assert.equal(h.store.state(id), 'rejected');
  await assert.rejects(h.service.send(id, message), { code: 'POLICY_DENIED' });

  const signed = (sha256: string) => ({ requestId: randomUUID(), approvalRequired: true, state: 'prepared', expiresAt: Date.now() + 60_000,
    signingText: JSON.stringify({ action: 'send_media', message: { chatId: '123456789', type: 2, sha256 } }) });
  const good = signed(createHash('sha256').update(PNG).digest('hex')), bad = signed('0'.repeat(64));
  const goodUrl = (h.center.offer(good, [PNG]) as { approvalUrl: string }).approvalUrl, badUrl = (h.center.offer(bad, [PNG]) as { approvalUrl: string }).approvalUrl;
  const img = await h.request('GET', `/api/approvals/${good.requestId}/media/0`, { headers: { 'x-approval-token': goodUrl.split('#')[1] } });
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/png'); assert.deepEqual(img.body, PNG);
  assert.equal((await h.request('GET', `/api/approvals/${bad.requestId}`, { headers: { 'x-approval-token': badUrl.split('#')[1] } })).json.media, 0);
});

test('at most five operations await passkey approval at once', async t => {
  const h = await harness(t);
  const offers = Array.from({ length: 6 }, () => h.center.offer({ requestId: randomUUID(), approvalRequired: true, state: 'prepared',
    expiresAt: Date.now() + 60_000, signingText: JSON.stringify({ action: 'send_message' }) }));
  assert.equal(offers.filter(o => o && o.approvalUrl).length, 5);
  assert.equal(offers[5]!.approvalUrl, null);
  assert.equal(h.center.offer({ requestId: randomUUID(), approvalRequired: false, state: 'prepared', expiresAt: Date.now() + 60_000, signingText: '{}' }), undefined);
});

test('page script compiles and renders agent text only through textContent', async () => {
  const { PAGE_JS, PAGE_HTML } = await import('./approval-page.ts');
  assert.doesNotThrow(() => new Function(PAGE_JS));
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(PAGE_JS), false);
  assert.equal(/<script>[^<]/.test(PAGE_HTML), false); // no inline script under the CSP
});

test('the passkey page can also allow the room for later sends, only together with a verified assertion', async t => {
  const h = await harness(t), device = await enroll(h);
  const id = randomUUID(), offer = h.center.offer(h.service.prepare(id, { chatId: '123456789', text: 'fixture remember' })) as { approvalUrl: string };
  const token = offer.approvalUrl.split('#')[1], api = `/api/approvals/${id}`;
  const view = await h.request('GET', api, { headers: { 'x-approval-token': token } });
  assert.equal(view.json.rememberable, true);
  const challenge = Buffer.from(view.json.challenge, 'base64url');
  assert.equal((await h.request('POST', `${api}/approve`, { headers: { 'x-approval-token': token }, body: { ...device.assert(challenge, ORIGIN, { flags: 0x01 }), remember: true } })).status, 403);
  assert.equal(h.recipients.list().length, 0);
  assert.equal((await h.request('POST', `${api}/approve`, { headers: { 'x-approval-token': token }, body: { ...device.assert(challenge, ORIGIN), remember: true } })).status, 200);
  assert.equal(h.recipients.get('123456789')!.approver, 'passkey');
});
