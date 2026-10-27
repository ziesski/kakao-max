import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KakaoDb } from './db.ts';
import { MessageStore, type StoredMessage } from './message-store.ts';
import { MessageInbox } from './message-inbox.ts';

const ROOM = '123456789', OTHER = '987654321';
const message = (id: string, chatId = ROOM): StoredMessage => ({ messageId: id, chatId, seq: 0, authorId: '123456789', text: 'fixture private text', type: 1, sendAt: 1 });
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-inbox-')), databases: KakaoDb[] = []; let now = 1000000;
  const open = () => { const db = KakaoDb.open({ dir: root }); databases.push(db); return { db, inbox: new MessageInbox(db, '123456789', () => now), store: new MessageStore(db) }; };
  const initial = open(); t.after(() => { for (const db of databases) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const claim = (inbox = initial.inbox, consumer = 'worker', limit = 100, chatId = ROOM) => inbox.claim({ chatId, consumer, limit, leaseMs: 1000 }, () => {});
  const ack = (inbox: MessageInbox, events: Array<{ eventId: string; leaseId: string }>, consumer = 'worker', chatId = ROOM) => inbox.ack({ sourceGeneration: inbox.sourceGeneration, chatId, consumer, events: events.map(({ eventId, leaseId }) => ({ eventId, leaseId })) }, () => {});
  return { ...initial, root, open, claim, ack, advance: (ms: number) => { now += ms; } };
}

test('a cursor never commits ahead of durable message/event work under injected failures', t => {
  for (const point of ['message','event','cursor'] as const) {
    const f = fixture(t), table = { message: 'messages', event: 'message_inbox_events', cursor: 'message_ingestion_cursors' }[point];
    f.db.db.exec(`CREATE TRIGGER fixture_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END`);
    assert.throws(() => f.inbox.commitBatch({ sourceGeneration: f.inbox.sourceGeneration, chatId: ROOM, expectedCursor: '0', messages: [message('9007199254740993'), message('9007199254740994')] }), { code: 'INTERNAL' });
    assert.equal(f.inbox.cursor(ROOM), '0'); assert.equal(f.store.getMessage(ROOM, '9007199254740993'), undefined); assert.equal(f.claim().events.length, 0);
    f.db.db.exec('DROP TRIGGER fixture_failure');
    f.inbox.commitBatch({ sourceGeneration: f.inbox.sourceGeneration, chatId: ROOM, expectedCursor: '0', messages: [message('9007199254740993')] });
    const restart = f.open(); assert.equal(restart.inbox.cursor(ROOM), '9007199254740993');
    // No notification was needed after commit; durable work is directly discoverable.
    assert.equal(f.claim(restart.inbox).events[0].messageId, '9007199254740993');
  }
});

test('source-scoped compare-and-swap rejects concurrent/old cursors and out-of-order collector batches', t => {
  const f = fixture(t), competing = f.open(), sourceGeneration = f.inbox.sourceGeneration;
  f.inbox.commitBatch({ sourceGeneration, chatId: ROOM, expectedCursor: '0', messages: [message('1'),message('2')] });
  assert.throws(() => competing.inbox.commitBatch({ sourceGeneration, chatId: ROOM, expectedCursor: '0', messages: [message('1'),message('2')] }), { code: 'CURSOR_CONFLICT' });
  assert.throws(() => f.inbox.commitBatch({ sourceGeneration: randomUUID(), chatId: ROOM, expectedCursor: '2', messages: [message('3')] }), { code: 'CURSOR_CONFLICT' });
  assert.throws(() => f.inbox.commitBatch({ sourceGeneration, chatId: ROOM, expectedCursor: '2', messages: [message('4'),message('3')] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.inbox.cursor(ROOM), '2'); assert.equal(f.claim().events.length, 2);
});

test('consumer crash/restart redelivers stable event IDs with fresh leases; old owners cannot acknowledge', t => {
  const f = fixture(t); f.inbox.ingest(message('9007199254740993'));
  const first = f.claim(), restart = f.open();
  assert.equal(f.claim(restart.inbox, 'other-worker').events.length, 0);
  f.advance(1000);
  const second = f.claim(restart.inbox, 'other-worker');
  assert.equal(second.events[0].eventId, first.events[0].eventId); assert.equal(second.events[0].attempts, 2);
  assert.notEqual(second.events[0].leaseId, first.events[0].leaseId);
  assert.throws(() => f.ack(f.inbox, first.events), { code: 'LEASE_CONFLICT' });
  assert.deepEqual(f.ack(restart.inbox, second.events, 'other-worker'), { acknowledged: 1, alreadyAcknowledged: 0 });
  f.advance(5000);
  assert.deepEqual(f.ack(restart.inbox, second.events, 'other-worker'), { acknowledged: 0, alreadyAcknowledged: 1 });
  assert.equal(f.claim(restart.inbox).events.length, 0);
});

test('two connections claim disjoint batches; lost acknowledgement and SQL failure cannot partially discard events', t => {
  const f = fixture(t); for (let i = 1; i <= 4; i++) f.inbox.ingest(message(String(i)));
  const other = f.open(), first = f.claim(f.inbox, 'worker', 2), second = f.claim(other.inbox, 'second', 2);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.eventId)).size, 4);
  f.db.db.exec(`CREATE TRIGGER fixture_ack_failure BEFORE UPDATE OF state ON message_inbox_events
    WHEN NEW.state='acked' AND OLD.message_id='2' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
  assert.throws(() => f.ack(f.inbox, first.events), { code: 'INTERNAL' });
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM message_inbox_events WHERE state='acked'").get() as { n: number }).n, 0);
  f.db.db.exec('DROP TRIGGER fixture_ack_failure');
  f.ack(f.inbox, first.events);
  assert.equal(f.ack(f.inbox, first.events).alreadyAcknowledged, 2);
  f.advance(1000); assert.equal(f.claim().events.length, 2);
});

test('authorization runs before selection/limit and acknowledgement; disabled/hidden/deleted work never consumes an authorized batch', t => {
  const f = fixture(t); for (let i = 1; i <= 10; i++) f.inbox.ingest(message(String(i), OTHER));
  f.inbox.ingest(message('11')); f.inbox.ingest(message('12')); f.inbox.ingest(message('13'));
  f.store.hideMessages(ROOM, ['11']); f.store.markDeleted(ROOM, '12');
  const denied = () => { throw new Error('fixture revoked'); };
  assert.throws(() => f.inbox.claim({ chatId: ROOM, consumer: 'worker', limit: 1, leaseMs: 1000 }, denied), { code: 'INTERNAL' });
  const batch = f.claim(f.inbox, 'worker', 1);
  assert.equal(batch.events[0].messageId, '13'); assert.equal(batch.hasMore, false);
  assert.throws(() => f.inbox.ack({ sourceGeneration: f.inbox.sourceGeneration, chatId: ROOM, consumer: 'worker', events: batch.events.map(({eventId,leaseId}) => ({eventId,leaseId})) }, denied), { code: 'INTERNAL' });
  f.advance(1000); assert.equal(f.claim().events[0].eventId, batch.events[0].eventId);
});

test('1001 records in bounded 200-row pages drain once into durable state without another source write', t => {
  const f = fixture(t);
  for (let first = 1; first <= 1001; first += 200) {
    const messages = Array.from({ length: Math.min(200, 1002-first) }, (_, i) => message(String(first+i)));
    f.inbox.commitBatch({ sourceGeneration: f.inbox.sourceGeneration, chatId: ROOM, expectedCursor: String(first-1), messages });
  }
  const restart = f.open(), seen = new Set<string>(); let hasMore: boolean;
  do {
    const batch = f.claim(restart.inbox); hasMore = batch.hasMore;
    for (const event of batch.events) { assert.equal(seen.has(event.eventId), false); seen.add(event.eventId); }
    f.ack(restart.inbox, batch.events.map(({eventId,leaseId}) => ({eventId,leaseId})));
  } while (hasMore);
  assert.equal(seen.size, 1001); assert.equal(f.claim().events.length, 0); assert.equal(f.inbox.cursor(ROOM), '1001');
  // Repeated/out-of-order live pushes update storage but never regress the cursor or reopen acked work.
  f.inbox.ingest(message('1')); assert.equal(f.inbox.cursor(ROOM), '1001'); assert.equal(f.claim().events.length, 0);
});

test('source generation survives restart, rejects account/key identity loss and never silently reuses a replaced database cursor', t => {
  const f = fixture(t); f.inbox.ingest(message('1')); assert.equal(f.open().inbox.sourceGeneration, f.inbox.sourceGeneration);
  assert.throws(() => new MessageInbox(f.db, OTHER), { code: 'CONFIG_INVALID' });
  f.db.db.prepare("DELETE FROM meta WHERE key='message-inbox-source'").run();
  assert.throws(() => new MessageInbox(f.db, ROOM), { code: 'CONFIG_INVALID' });
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-replaced-')), db = KakaoDb.open({ dir: otherDir });
  t.after(() => { db.close(); fs.rmSync(otherDir, { recursive: true, force: true }); });
  assert.notEqual(new MessageInbox(db, ROOM).sourceGeneration, f.inbox.sourceGeneration);
});

test('a colliding room/message identity fails closed instead of overwriting data or advancing work', t => {
  const f = fixture(t); f.inbox.ingest(message('1'));
  assert.throws(() => f.inbox.ingest(message('1', OTHER)), { code: 'HISTORY_CONFLICT' });
  assert.equal(f.inbox.cursor(OTHER), '0'); assert.equal(f.store.getMessage(ROOM, '1')?.chatId, ROOM);
  assert.equal(f.claim(f.inbox, 'worker', 100, OTHER).events.length, 0);
});

test('simultaneous processes claim disjoint leases under the SQLite writer lock', async t => {
  const { spawn } = await import('node:child_process');
  const f = fixture(t); for (let i=1; i<=20; i++) f.inbox.ingest(message(String(i)));
  const script = `import { KakaoDb } from ${JSON.stringify(new URL('./db.ts', import.meta.url).href)};
    import { MessageInbox } from ${JSON.stringify(new URL('./message-inbox.ts', import.meta.url).href)};
    const db=KakaoDb.open({dir:process.argv[1]});
    const q=new MessageInbox(db,'123456789');
    process.stdout.write(JSON.stringify(q.claim({chatId:'123456789',consumer:process.argv[2],limit:10,leaseMs:60000},()=>{}).events.map(e=>e.eventId)));
    db.close();`;
  const run = (consumer: string) => new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types','--input-type=module','--eval',script,f.root,consumer], { stdio: ['ignore','pipe','pipe'] });
    let out = '', err = ''; child.stdout.on('data', b => { out += b.toString(); }); child.stderr.on('data', b => { err += b.toString(); });
    const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture claim timeout'));},15000);
    child.once('error', error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`Fixture claim failed ${code}: ${err}`));else {try{resolve(JSON.parse(out));}catch(error){reject(error);}}});
  });
  const [a,b]=await Promise.all([run('first-process'),run('second-process')]);
  assert.equal(a.length,10);assert.equal(b.length,10);assert.equal(new Set([...a,...b]).size,20);
});

test('a high-water push does not skip an unfinished ordered collection; pending pages stay discoverable without new writes', t => {
  const f = fixture(t); f.inbox.ingest(message('5'));
  assert.equal(f.inbox.cursor(ROOM), '0'); assert.equal(f.inbox.observedHead(ROOM), '5');
  const first = f.inbox.commitBatch({ sourceGeneration: f.inbox.sourceGeneration, chatId: ROOM, expectedCursor: '0', messages: [message('1'),message('2')] });
  assert.equal(first.hasMore,true); assert.equal(first.cursor,'2'); assert.equal(first.observedHead,'5');
  const next = f.open().inbox;
  assert.equal(next.observedHead(ROOM),'5');
  const second=next.commitBatch({sourceGeneration:next.sourceGeneration,chatId:ROOM,expectedCursor:'2',messages:[message('3'),message('4'),message('5')]});
  assert.equal(second.hasMore,false); assert.equal(second.eventsCreated,2); assert.equal(f.claim().events.length,5);
});
