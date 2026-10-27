import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KakaoAuthClient, calculateXVC, DEFAULT_AUTH_CONFIG } from './auth-client.js';

test('calculateXVC generates 16-character hex digest', () => {
  const xvc = calculateXVC('00000000-0000-0000-0000-000000000001', 'KT/26.4.0 Wd/15.3 ko', 'test@example.com');
  assert.equal(typeof xvc, 'string');
  assert.equal(xvc.length, 16);
  assert.match(xvc, /^[0-9a-f]{16}$/);
});

test('KakaoAuthClient formats correct User-Agent (Mac = Mc token)', () => {
  const client = new KakaoAuthClient('Web Client', 'uuid-123', {
    agent: 'mac',
    version: '26.4.0',
    osVersion: '26.3.1',
    language: 'ko'
  });
  assert.equal(client.userAgent, 'KT/26.4.0 Mc/26.3.1 ko');
});

test('authorization header is accessToken-deviceUuid', () => {
  assert.equal(KakaoAuthClient.authorization('TOKEN123', 'DEVUUID=='), 'TOKEN123-DEVUUID==');
});
