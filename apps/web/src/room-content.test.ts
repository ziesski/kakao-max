import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedHistory, metadataChat } from './room-content.ts';

test('GUI history fails closed on denied/disconnected reads and returns only the fresh authorized batch', async () => {
  let requests = 0;
  const denied = async (): Promise<{ messages: any[] }> => { requests++; throw new Error('POLICY_DENIED'); };
  await assert.rejects(authorizedHistory(false, denied));
  assert.equal(requests, 0);
  await assert.rejects(authorizedHistory(true, denied), /POLICY_DENIED/);
  assert.equal(requests, 1);
  const fresh = [{ messageId: '123456789', text: 'fixture' }];
  assert.deepEqual(await authorizedHistory(true, async () => ({ messages: fresh })), fresh);
});

test('metadata strips old cached previews without changing internal retention', () => {
  const cached = { id: '123456789', lastMessage: 'private fixture', lastMessageType: 1 };
  assert.deepEqual(metadataChat(cached), { id: cached.id, lastMessage: '', lastMessageType: undefined });
  assert.equal(cached.lastMessage, 'private fixture');
});
