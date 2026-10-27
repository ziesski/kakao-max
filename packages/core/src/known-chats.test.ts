import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KnownChats } from './known-chats.ts';
import { KakaoDb } from './db.ts';

test('KnownChats persists remembered chats across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-chats-'));
  const db1 = KakaoDb.open({ dir });
  const a = new KnownChats(db1);
  a.remember({ id: '1', type: 'DirectChat', title: 'A' });
  a.remember({ id: '2', type: 'MultiChat' });
  a.remember({ id: '2', type: '', title: 'Group' }); // keeps type, adds title
  db1.close();

  const db2 = KakaoDb.open({ dir });
  assert.deepEqual(new KnownChats(db2).list(), [
    { id: '1', type: 'DirectChat', title: 'A' },
    { id: '2', type: 'MultiChat', title: 'Group' }
  ]);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('KnownChats starts empty on a fresh database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-chats-'));
  const db = KakaoDb.open({ dir });
  assert.deepEqual(new KnownChats(db).list(), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
