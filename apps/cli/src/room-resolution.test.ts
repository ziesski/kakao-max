import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoom } from './room-resolution.ts';

test('room names never silently choose the first duplicate or substring match', () => {
  const rooms = [{ id: '123456789', title: 'fixture team', type: 'DirectChat' }, { id: '987654321', title: 'fixture team', type: 'MultiChat' }];
  assert.throws(() => resolveRoom(rooms, 'fixture team'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resolveRoom(rooms, 'fixture'), { code: 'INVALID_ARGUMENT' });
  assert.equal(resolveRoom(rooms, 'missing'), undefined);
  assert.equal(resolveRoom(rooms, ''), undefined);
});

test('self never falls back to the first room or a display name impersonating self', () => {
  const rooms = [{ id: '123456789', title: '나와의 채팅', type: 'DirectChat' }];
  assert.equal(resolveRoom(rooms, 'self'), undefined);
  const memo = { id: '987654321', title: 'fixture memo', type: 'MemoChat' };
  assert.equal(resolveRoom([...rooms, memo], 'self')?.id, memo.id);
});

test('canonical IDs take precedence over indexes and preserve integers beyond JS precision', () => {
  const rooms = [{ id: '2', title: 'fixture first' }, { id: '1', title: 'fixture second' }, { id: '9007199254740993' }];
  assert.equal(resolveRoom(rooms, '1')?.id, '1');
  assert.equal(resolveRoom(rooms, '#1')?.id, '2');
  assert.equal(resolveRoom(rooms, '9007199254740993')?.id, '9007199254740993');
});
