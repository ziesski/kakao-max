import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from './validate-args.ts';

const schema = {
  type: 'object' as const,
  properties: {
    chatId: { type: 'string' },
    confirm: { type: 'boolean' },
    logIds: { type: 'array', items: { type: 'string' } },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { userId: { type: 'string' }, at: { type: 'array', items: { type: 'number' } }, len: { type: 'number' } },
        required: ['userId', 'at', 'len']
      }
    }
  },
  required: ['chatId'],
  additionalProperties: false
};

test('valid arguments produce no problems; null/undefined count as omitted', () => {
  assert.deepEqual(validateArgs(schema, { chatId: 'c', confirm: true, logIds: ['1'], mentions: [{ userId: '2', at: [0], len: 3 }] }), []);
  assert.deepEqual(validateArgs(schema, { chatId: 'c', confirm: null }), []);
});

test('reports every problem, including nested array items', () => {
  const problems = validateArgs(schema, { confirm: 'yes', logIds: ['1', 2], mentions: [{ userId: '2', at: 'x' }] });
  assert.deepEqual(problems.sort(), [
    '"chatId" is required',
    '"confirm" must be boolean',
    '"logIds"[1] must be string',
    '"mentions"[0].at must be array',
    '"mentions"[0].len is required'
  ]);
});

test('non-object arguments are rejected; extra keys allowed when not forbidden', () => {
  assert.deepEqual(validateArgs(schema, [1]), ['arguments must be an object']);
  assert.deepEqual(validateArgs({ type: 'object', properties: {} }, { anything: 1 }), []);
});
