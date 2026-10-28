import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserReadClient } from './user-client.ts';

test('owner client requires one explicit endpoint and never infers an agent transport', () => {
  assert.throws(() => new UserReadClient({}), { code: 'CONFIG_INVALID' });
  assert.throws(() => new UserReadClient({ socketPath: '/fixture', command: ['fixture'] }), { code: 'CONFIG_INVALID' });
  for (const command of [[], ['fixture', 'bad\narg'], [42] as any]) assert.throws(() => new UserReadClient({ command }), { code: 'CONFIG_INVALID' });
});

test('old or malformed helper output is rejected without echoing private stdout', async () => {
  const client = new UserReadClient({ command: [process.execPath, '-e', 'process.stdout.write("private-fixture-output\\n"); setTimeout(()=>{},1000)'] });
  try {
    await assert.rejects(client.connect(), (e: any) => {
      assert.equal(e.code, 'USER_API_UNAVAILABLE'); assert.ok(!e.message.includes('private-fixture-output')); return true;
    });
  } finally { client.close(); }
});
