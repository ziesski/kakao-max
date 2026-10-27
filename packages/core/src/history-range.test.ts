import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryRange, historyRangeCursor } from './history-range.ts';

const args = { from: '2026-10-23T00:00:00-07:00', to: '2026-10-25T00:00:00-07:00' };
test('history range requires timezone-qualified bounded dates and scoped validated cursor state', () => {
  const first = parseHistoryRange('123456789', args, '900');
  assert.equal(first.to - first.from, 48 * 3600);
  assert.deepEqual(parseHistoryRange('123456789', { ...args, cursor: historyRangeCursor(first.state) }, '901').state, first.state);
  for (const opts of [ { ...args, from: '2026-10-23T00:00:00' }, { ...args, to: args.from },
    { ...args, limit: 101 }, { ...args, from: '2026-02-30T00:00:00Z' }, { ...args, to: '2026-12-25T00:00:00Z' }, { ...args, cursor: 'invalid' },
    { ...args, cursor: historyRangeCursor({ ...first.state, since: '901' }) },
    { ...args, cursor: historyRangeCursor({ ...first.state, pages: 21 }) },
    { ...args, cursor: historyRangeCursor({ ...first.state, before: { sendAt: first.from, logId: '10' } }) } ]) {
    assert.throws(() => parseHistoryRange('123456789', opts, '900'), { code: 'INVALID_ARGUMENT' });
  }
});
