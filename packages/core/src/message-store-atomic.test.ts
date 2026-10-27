import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KakaoDb } from './db.ts';
import { MessageStore } from './message-store.ts';

test('missing-message insertion rolls back the complete batch on a database error', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drawer-atomic-'));
  const db = KakaoDb.open({ dir: directory });
  context.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new MessageStore(db);
  const message = { seq: 0, chatId: '123456789', messageId: '123', authorId: '987654321', text: 'synthetic', sendAt: 1700000000 };
  // A genuine SQL failure on row two must undo row one.
  db.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON messages WHEN NEW.message_id = '124' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => store.saveMissingMessages([message, { ...message, messageId: '124' }]));
  assert.equal(store.getChatStats(message.chatId).messageCount, 0);
});
