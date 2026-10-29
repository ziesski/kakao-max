import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RegistrationTrace } from './device-registration.js';
import { generateDeviceUuid, KakaoDeviceRegistration, STATUS_CONFIRM_PENDING } from './device-registration.js';

test('generateDeviceUuid produces 52-byte standard-base64 values (device key format)', () => {
  const u = generateDeviceUuid();
  assert.match(u, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(u, 'base64').length, 52);
  assert.notEqual(generateDeviceUuid(), generateDeviceUuid()); // random
});

/**
 * Stub fetch with a scripted sequence of account responses. Each call pops the next
 * scripted entry (matched loosely by endpoint) and records the request.
 */
function scriptFetch(script: Array<{ endpoint: string; status: number; body?: Record<string, unknown> }>) {
  const calls: { endpoint: string; fields: URLSearchParams; json?: Record<string, unknown> }[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const endpoint = String(url).split('/account/')[1];
    calls.push({ endpoint, fields: new URLSearchParams(init.body), ...(String(init.body).startsWith('{') ? { json: JSON.parse(init.body) } : {}) });
    const entry = script[i++];
    assert.ok(entry, 'unexpected extra authentication request');
    assert.equal(endpoint, entry.endpoint);
    return new Response(JSON.stringify({ status: entry.status, ...(entry.body ?? {}) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('register runs the full sign flow: login(-100) -> request_sign -> poll confirm_sign -> login', async () => {
  const stub = scriptFetch([
    { endpoint: 'login.json', status: -100, body: { registerDeviceWithSign: true } },
    { endpoint: 'request_sign.json', status: 0, body: { os_name: 'ios', interval: 0, expire_after: 5 } },
    { endpoint: 'confirm_sign.json', status: STATUS_CONFIRM_PENDING },
    { endpoint: 'confirm_sign.json', status: STATUS_CONFIRM_PENDING },
    { endpoint: 'confirm_sign.json', status: 0 }, // approved on phone
    { endpoint: 'login.json', status: 0, body: { userId: '42', access_token: 'TOK', refresh_token: 'REF' } }
  ]);
  try {
    const reg = new KakaoDeviceRegistration('KakaoWeb', { agent: 'mac' });
    let awaited: any = null;
    const res = await reg.register('me@example.com', 'pw', {
      pollIntervalSec: 0,
      onAwaitingApproval: (i) => { awaited = i; }
    });

    assert.equal(res.status, 0);
    assert.deepEqual(res.credentials, { userId: '42', accessToken: 'TOK', refreshToken: 'REF' });
    assert.equal(awaited.osName, 'ios');

    // Verify the call order + that the device_uuid is carried consistently.
    assert.deepEqual(
      stub.calls.map((c) => c.endpoint),
      ['login.json', 'request_sign.json', 'confirm_sign.json', 'confirm_sign.json', 'confirm_sign.json', 'login.json']
    );
    const uuids = new Set(stub.calls.map((c) => c.fields.get('device_uuid')));
    assert.equal(uuids.size, 1);
    assert.equal([...uuids][0], reg.deviceUuid);
    // request_sign / confirm_sign carry no publicKey/signature (phone-approval flow).
    assert.equal(stub.calls[1].fields.get('publicKey'), null);
    assert.equal(stub.calls[1].fields.get('signature'), null);
  } finally {
    stub.restore();
  }
});

test('register short-circuits when the device is already registered (login status 0)', async () => {
  const stub = scriptFetch([{ endpoint: 'login.json', status: 0, body: { userId: '7', access_token: 'A' } }]);
  try {
    const reg = new KakaoDeviceRegistration('KakaoWeb', {}, 'SUPPLIED_UUID');
    const res = await reg.register('me@example.com', 'pw');
    assert.equal(res.status, 0);
    assert.equal(res.deviceUuid, 'SUPPLIED_UUID');
    assert.equal(res.credentials?.accessToken, 'A');
    assert.equal(stub.calls.length, 1); // no sign flow needed
  } finally {
    stub.restore();
  }
});

test('registration diagnostics retain the initial sign flag through routing decisions without leaking response values or retrying', async () => {
  const cases = [
    { body: { registerDeviceWithSign: true }, expected: 'enabled' },
    { body: { registerDeviceWithSign: false }, expected: 'disabled' },
    { body: {}, expected: 'absent' },
    { body: { registerDeviceWithSign: 'fixture-private' }, expected: 'invalid' },
    { body: { registerDeviceWithSign: null }, expected: 'invalid' }
  ];
  for (const { body, expected } of cases) {
    const stub = scriptFetch([
      { endpoint: 'login.json', status: -100, body: { ...body, access_token: 'fixture-private-token' } },
      { endpoint: 'request_sign.json', status: -500, body: { message: 'fixture-private-message' } }
    ]);
    try {
      const traces: RegistrationTrace[] = [];
      let awaiting = false;
      const result = await new KakaoDeviceRegistration('fixture').register('fixture@example.com', 'fixture-password', {
        onResponse: trace => traces.push(trace), onAwaitingApproval: () => { awaiting = true; }
      });
      assert.equal(result.status, expected === 'enabled' ? -500 : -100);
      assert.equal(result.failure, expected === 'enabled' ? undefined : 'unsupported-method');
      assert.equal(awaiting, false);
      assert.deepEqual(stub.calls.map(call => call.endpoint), expected === 'enabled' ? ['login.json', 'request_sign.json'] : ['login.json']);
      const expectedTraces = [
        { stage: 'initial_login' },
        { stage: 'initial_login', status: -100, httpStatus: 200, signRegistration: expected },
        { stage: 'request_sign', signRegistration: expected },
        { stage: 'request_sign', status: -500, httpStatus: 200, signRegistration: expected }
      ];
      assert.deepEqual(traces, expected === 'enabled' ? expectedTraces : expectedTraces.slice(0, 2));
      assert.doesNotMatch(JSON.stringify(traces), /fixture-private|fixture@example|fixture-password/);
    } finally { stub.restore(); }
  }
});

test('register surfaces a confirm_sign rejection (non-pending, non-zero)', async () => {
  const stub = scriptFetch([
    { endpoint: 'login.json', status: -100, body: { registerDeviceWithSign: true } },
    { endpoint: 'request_sign.json', status: 0, body: { interval: 0 } },
    { endpoint: 'confirm_sign.json', status: -999 } // hard failure
  ]);
  try {
    const reg = new KakaoDeviceRegistration('KakaoWeb');
    const res = await reg.register('me@example.com', 'pw', { pollIntervalSec: 0 });
    assert.equal(res.status, -999);
    assert.match(res.message!, /confirm_sign rejected/);
  } finally {
    stub.restore();
  }
});


test('disabled sign flag uses the passcode flow with one device identity and no sign request', async () => {
  const stub = scriptFetch([
    { endpoint: 'login.json', status: -100, body: { registerDeviceWithSign: false } },
    { endpoint: 'passcodeLogin/generate', status: 0, body: { passcode: '0123', remainingSeconds: 120 } },
    { endpoint: 'passcodeLogin/registerDevice', status: -100, body: { nextRequestIntervalInSeconds: 3 } },
    { endpoint: 'passcodeLogin/registerDevice', status: 0 },
    { endpoint: 'login.json', status: 0, body: { userId: '42', access_token: 'fixture-token' } }
  ]);
  try {
    const reg = new KakaoDeviceRegistration('fixture'), shown: string[] = [], traces: RegistrationTrace[] = [];
    const result = await reg.register('fixture@example.test', 'fixture-password', {
      onPasscode: info => { shown.push(info.passcode); assert.equal(info.remainingSeconds, 120); },
      onResponse: trace => traces.push(trace), pollIntervalSec: 0
    });
    assert.equal(result.status, 0); assert.equal(result.credentials?.accessToken, 'fixture-token');
    assert.deepEqual(shown, ['0123']);
    assert.equal(stub.calls.length, 5);
    assert.ok(stub.calls.every(c => !c.endpoint.includes('_sign')));
    const generated = stub.calls[1].json!, polled = stub.calls[2].json!;
    assert.deepEqual(generated, polled);
    assert.deepEqual(generated.device, { name: 'fixture', uuid: reg.deviceUuid, osVersion: '26.3.1', model: 'MacBookPro' });
    assert.ok(stub.calls.filter(c => c.endpoint === 'login.json').every(c => c.fields.get('device_uuid') === reg.deviceUuid));
    assert.ok(traces.filter(t => t.status !== undefined).every(t => t.signRegistration === 'disabled'));
    assert.doesNotMatch(JSON.stringify(traces), /0123|fixture-token|fixture-password|fixture@example/);
  } finally { stub.restore(); }
});

test('passcode failures stop without sign fallback, final login or callback on malformed data', async () => {
  for (const kind of ['generate-reject', 'malformed', 'poll-reject', 'timeout'] as const) {
    const stub = scriptFetch([
      { endpoint: 'login.json', status: -100, body: { registerDeviceWithSign: false } },
      { endpoint: 'passcodeLogin/generate', status: kind === 'generate-reject' ? -500 : 0,
        body: { passcode: kind === 'malformed' ? 'fixture-private' : '0123', remainingSeconds: 120 } },
      { endpoint: 'passcodeLogin/registerDevice', status: -110 }
    ]);
    try {
      let shown = 0;
      const result = await new KakaoDeviceRegistration('fixture').register('fixture@example.test', 'fixture-password', {
        onPasscode: () => { shown++; }, pollIntervalSec: 0, ...(kind === 'timeout' ? { timeoutSec: 0 } : {})
      });
      assert.notEqual(result.status, 0); assert.equal(result.credentials, undefined);
      assert.equal(shown, kind === 'poll-reject' ? 1 : 0);
      assert.equal(stub.calls.length, kind === 'poll-reject' ? 3 : 2);
      assert.ok(stub.calls.every(c => !c.endpoint.includes('_sign')));
    } finally { stub.restore(); }
  }
});

test('a login error cannot trigger registration even if a sign flag is present', async () => {
  const stub = scriptFetch([{ endpoint: 'login.json', status: 30, body: { registerDeviceWithSign: true } }]);
  try {
    const result = await new KakaoDeviceRegistration('fixture').register('fixture@example.test', 'fixture-password');
    assert.equal(result.status, 30); assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});


test('tablet registration without Mac sign flag uses passcode and retains one fresh Android identity', async () => {
  const stub = scriptFetch([
    { endpoint: 'login.json', status: -100 },
    { endpoint: 'passcodeLogin/generate', status: 0, body: { passcode: '1234', remainingSeconds: 60 } },
    { endpoint: 'passcodeLogin/registerDevice', status: 0 },
    { endpoint: 'login.json', status: 0, body: { userId: '42', access_token: 'token' } }
  ]);
  try {
    const reg = new KakaoDeviceRegistration('SM-T870', { agent: 'android' });
    assert.match(reg.deviceUuid, /^[a-f0-9]{64}$/);
    const codes: string[] = [];
    const result = await reg.register('fixture@example.test', 'fixture', { onPasscode: i => codes.push(i.passcode) });
    assert.equal(result.status, 0); assert.deepEqual(codes, ['1234']);
    assert.equal(stub.calls[0].fields.get('device_uuid'), reg.deviceUuid);
    assert.equal((stub.calls[1].json?.device as { uuid: string }).uuid, reg.deviceUuid);
    assert.equal((stub.calls[2].json?.device as { uuid: string }).uuid, reg.deviceUuid);
    assert.equal(stub.calls[3].fields.get('device_uuid'), reg.deviceUuid);
  } finally { stub.restore(); }
});

test('tablet conflict never takes over even when the PC takeover option is set', async () => {
  const stub = scriptFetch([{ endpoint: 'login.json', status: -101 }]);
  try {
    const reg = new KakaoDeviceRegistration('SM-T870', { agent: 'android' });
    const result = await reg.register('fixture@example.test', 'fixture', { confirmTakeover: true });
    assert.equal(result.status, -101); assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].fields.get('forced'), 'false');
  } finally { stub.restore(); }
});

test('tablet does not request a code without a human callback or guess an unknown registration method', async () => {
  for (const body of [{}, { registerDeviceWithSign: true }, { registerDeviceWithSign: 'invalid' }]) {
    const stub = scriptFetch([{ endpoint: 'login.json', status: -100, body }]);
    try {
      const result = await new KakaoDeviceRegistration('SM-T870', { agent: 'android' }).register('fixture@example.test', 'fixture');
      assert.equal(result.failure, 'unsupported-method'); assert.equal(stub.calls.length, 1);
    } finally { stub.restore(); }
  }
});
