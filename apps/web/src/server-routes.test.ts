// The real GUI server process (no daemon behind it): the panel and write routes sit behind the same
// launch-session, Host, Sec-Fetch-Site/Origin and JSON-only checks as every other /api route.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));

async function startGui(): Promise<{ base: string; launch: string }> {
  // MCP_PORT 9 (discard) on loopback: nothing answers, so the GUI stays disconnected.
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], { env: { ...process.env, PORT: '0', MCP_HOST: '127.0.0.1', MCP_PORT: '9' }, stdio: ['ignore', 'pipe', 'pipe'] });
  after(() => { child.kill(); });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GUI did not start: ${out}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:(\d+))\/launch\?t=[A-Za-z0-9_-]+/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: m[1], launch: m[0] }); }
    });
    child.on('exit', (code) => reject(new Error(`GUI exited ${code}: ${out}`)));
  });
}

const gui = startGui();
let cookie = '';
async function session(): Promise<{ base: string; cookie: string }> {
  const { base, launch } = await gui;
  if (!cookie) {
    const r = await fetch(launch, { redirect: 'manual' });
    cookie = String(r.headers.get('set-cookie')).split(';')[0];
  }
  return { base, cookie };
}
const json = { 'content-type': 'application/json' };

test('panel and write routes refuse requests without the launch session', async () => {
  const { base } = await gui;
  for (const [p, method] of [['/api/control', 'GET'], ['/api/control/pause', 'POST'], ['/api/control/revoke', 'POST'], ['/api/send', 'POST']]) {
    const r = await fetch(base + p, { method, headers: json, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
});

test('panel writes refuse another website and a form post even with the session', async () => {
  const { base, cookie } = await session();
  const pause = JSON.stringify({ paused: true });
  const cases: Array<[Record<string, string>, string]> = [
    [{ ...json, cookie, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, 'cross-site'],
    [{ ...json, cookie, origin: 'https://attacker.example' }, 'origin'],
    [{ 'content-type': 'text/plain', cookie }, 'content-type']
  ];
  for (const [headers, why] of cases) {
    const r = await fetch(`${base}/api/control/pause`, { method: 'POST', headers, body: pause });
    assert.equal(r.status, 403, why);
  }
});

test('with the session, the panel reports a disconnected daemon and writes need a page-chosen requestId', async () => {
  const { base, cookie } = await session();
  const control = await (await fetch(`${base}/api/control`, { headers: { cookie } })).json();
  assert.equal(control.status.connected, false); assert.deepEqual(control.permissions, []);
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { ...json, cookie, origin: base, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  for (const [p, body] of [['/api/send', { chatId: '1', text: 'x' }], ['/api/delete', { chatId: '1', logId: '2' }], ['/api/forward', { chatId: '1', text: 'x' }],
    ['/api/leave', { chatId: '1' }], ['/api/control/resume', {}], ['/api/send', { chatId: '1', text: 'x', requestId: 'not-a-uuid' }]] as const) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p); assert.equal((await r.json()).code, 'INVALID_REQUEST_ID', p);
  }
  const offline = await post('/api/send', { chatId: '1', text: 'x', requestId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: 'Not connected to the daemon; nothing was sent', code: 'DAEMON_NOT_CONNECTED', uncertain: false, retryable: true });
  assert.equal((await post('/api/control/pause', { paused: true })).status, 503);
});
