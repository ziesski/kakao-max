import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, type MessageWriter, type WriteResult } from './conversation.ts';
import type { ConversationReader, ConversationMessage } from './types.ts';

const m = (n: number, text = 'fixture'): ConversationMessage => ({ messageId: String(n), authorId: '1', text, type: 1 });
function fixture() {
  let rows = [m(10)], removed: string[] = [], reset = false, error: Error | undefined;
  const ids: string[] = [];
  let write: WriteResult = { ok: true, messageId: '20' };
  const reader: ConversationReader = { async status() { return { connected: true, userId: '1' }; }, async rooms() { return [{ id: '1', title: 'fixture A' }, { id: '2', title: 'fixture B' }]; },
    async history() { if (error) throw error; return { messages: rows, hasMore: false }; },
    async updates() { if (error) throw error; return { messages: rows, removedIds: removed, reset }; } };
  const writer: MessageWriter = { async identity() { return { connected: true, userId: '1' }; }, async send(_room, _text, id) { ids.push(id); return write; } };
  const conversation = new Conversation(reader, writer, () => {});
  return { conversation, reader, writer, ids, setRows: (r: ConversationMessage[]) => { rows = r; }, setRemoved: (r: string[]) => { removed = r; },
    setReset: (r: boolean) => { reset = r; }, setError: (e?: Error) => { error = e; }, setWrite: (r: WriteResult) => { write = r; } };
}

test('conversation merges edits/deletions and bounds memory without duplicate messages', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  f.setRows([m(10, 'edited'), m(11)]); await f.conversation.poll();
  assert.equal(f.conversation.messages[0].text, 'edited'); assert.equal(f.conversation.messages.length, 2);
  f.setRemoved(['10']); f.setRows([m(11)]); await f.conversation.poll();
  assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['11']);
  f.setRows(Array.from({ length: 250 }, (_, i) => m(i + 100))); await f.conversation.poll();
  assert.equal(f.conversation.messages.length, 200);
  f.setReset(true); f.setRows([m(500)]); await f.conversation.poll();
  assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['500']);
});

test('late history for a previous room cannot populate the newly selected room', async () => {
  const f = fixture(); await f.conversation.start();
  let finish!: (value: { messages: ConversationMessage[]; hasMore: boolean }) => void;
  f.reader.history = room => room === '1' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ messages: [m(200)], hasMore: false });
  const first = f.conversation.open('1'); await f.conversation.open('2');
  finish({ messages: [m(100, 'wrong room')], hasMore: false }); await first;
  assert.equal(f.conversation.active?.id, '2'); assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['200']);
});

test('late polling after switching rooms or closing cannot restore previous content', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  let finish!: (value: any) => void;
  f.reader.updates = () => new Promise(resolve => { finish = resolve; });
  const pending = f.conversation.poll(); await f.conversation.open('2');
  finish({ messages: [m(99, 'old room')], reset: false, removedIds: [] }); await pending;
  assert.ok(!f.conversation.messages.some(m => m.text === 'old room'));
  const late = f.conversation.poll(); f.conversation.close();
  finish({ messages: [m(100)], reset: false, removedIds: [] }); await late;
  assert.deepEqual(f.conversation.messages, []); assert.equal(f.conversation.connected, false);
});

test('uncertain writes and malformed acknowledgements keep one request ID and prevent another send', async () => {
  for (const result of [
    { ok: false, code: 'SEND_OUTCOME_UNKNOWN', message: 'fixture unknown', uncertain: true },
    { ok: true, messageId: 'invalid' }
  ] as WriteResult[]) {
    const f = fixture(); await f.conversation.start(); await f.conversation.open('1'); f.setWrite(result);
    await assert.rejects(f.conversation.send('fixture')); await assert.rejects(f.conversation.send('fixture'));
    assert.equal(f.ids.length, 1); assert.equal(f.conversation.pending?.requestId, f.ids[0]);
  }
});

test('read failure clears displayed content, stops polling and requires explicit refresh', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  f.setError(new Error('fixture disconnected')); await assert.rejects(f.conversation.poll());
  assert.equal(f.conversation.live, false); assert.deepEqual(f.conversation.messages, []);
  f.setError(); await f.conversation.refresh(); assert.equal(f.conversation.live, true);
});

test('different read/write accounts cannot start a conversation or send after an identity change', async () => {
  const f = fixture(); f.writer.identity = async () => ({ connected: true, userId: '2' });
  await assert.rejects(f.conversation.start(), { code: 'ACCOUNT_MISMATCH' }); assert.equal(f.ids.length, 0);
  f.writer.identity = async () => ({ connected: true, userId: '1' }); await f.conversation.start(); await f.conversation.open('1');
  f.writer.identity = async () => ({ connected: true, userId: '2' });
  await assert.rejects(f.conversation.send('do not send'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.ids.length, 0); assert.equal(f.conversation.pending, undefined);
});

test('concurrent Enter/send attempts still allocate only one write after identity checks', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  const waits: ((value: { connected: boolean; userId: string }) => void)[] = [];
  f.writer.identity = () => new Promise(resolve => { waits.push(resolve); });
  f.writer.send = async (_room, _text, id) => { f.ids.push(id); return new Promise(() => {}); };
  void f.conversation.send('first');
  const second = f.conversation.send('second');
  waits[0]({ connected: true, userId: '1' }); waits[1]({ connected: true, userId: '1' });
  await assert.rejects(second, { code: 'SEND_PENDING' }); assert.equal(f.ids.length, 1); f.conversation.close();
});

test('polls coalesce and an explicit refresh supersedes an old poll response', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  let count = 0, finish!: (value: any) => void;
  f.reader.updates = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const a = f.conversation.poll(), b = f.conversation.poll(); assert.equal(count, 1);
  f.setRows([m(10, 'fresh explicit history')]); await f.conversation.refresh();
  finish({ messages: [m(10, 'stale poll')], removedIds: [], reset: false }); await Promise.all([a, b]);
  assert.equal(f.conversation.messages[0].text, 'fresh explicit history');
});

test('failed or missing identity handshake cannot be skipped by refreshing or opening rooms', async () => {
  const f = fixture();
  await assert.rejects(f.conversation.open('1'), { code: 'NOT_CONNECTED' });
  await assert.rejects(f.conversation.refreshRooms(), { code: 'NOT_CONNECTED' });
  f.writer.identity = async () => ({ connected: true, userId: '2' });
  await assert.rejects(f.conversation.start(), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(f.conversation.refresh(), { code: 'NOT_CONNECTED' });
  assert.equal(f.conversation.active, undefined);
});


test('late polls cannot advance the cursor after an explicit history refresh', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  let finish!: (v: any) => void;
  const cursors: (number | undefined)[] = [];
  f.reader.updates = async (_room, _after, _visible, cursor) => {
    cursors.push(cursor);
    if (cursors.length === 1) return new Promise(resolve => { finish = resolve; });
    return { messages: [], removedIds: [], reset: false, cursor: 2 };
  };
  const old = f.conversation.poll(); await f.conversation.refresh();
  await f.conversation.poll();
  finish({ messages: [], removedIds: [], reset: false, cursor: 900 }); await old;
  await f.conversation.poll();
  assert.deepEqual(cursors, [0, 0, 2]);
});


test('refresh retries only the latest valid requested room and respects room visibility', async () => {
  const f = fixture(); await f.conversation.start();
  const calls: string[] = [];
  f.reader.history = async room => { calls.push(room); throw new Error('fixture denied'); };
  await assert.rejects(f.conversation.open('1'));
  await assert.rejects(f.conversation.open('2'));
  await assert.rejects(f.conversation.refresh());
  assert.deepEqual(calls, ['1', '2', '2']);
  await assert.rejects(f.conversation.open('missing'), { code: 'ROOM_NOT_AVAILABLE' });
  await f.conversation.refresh();
  assert.deepEqual(calls, ['1', '2', '2']);
  const hidden = new Conversation(f.reader, f.writer, () => {}, () => false);
  await hidden.start();
  await assert.rejects(hidden.open('1'), { code: 'ROOM_NOT_AVAILABLE' });
  await hidden.refresh();
  assert.deepEqual(calls, ['1', '2', '2']);
});


test('read limits preserve history and a successful send appends without hiding the stopped read state', async () => {
  const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
  const error = Object.assign(new Error('fixture read budget'), { code: 'RATE_LIMITED' });
  f.setError(error);
  await assert.rejects(f.conversation.poll(), e => e === error);
  assert.equal(f.conversation.live, false);
  assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['10']);
  await f.conversation.send('fixture reply');
  assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['10', '20']);
  assert.equal(f.conversation.readError, error);
  assert.equal(f.conversation.live, false);
  f.setError(Object.assign(new Error('fixture revoked'), { code: 'POLICY_DENIED' }));
  await assert.rejects(f.conversation.refresh());
  assert.deepEqual(f.conversation.messages, []);
});

test('temporary read failures retain the last view until a successful explicit refresh', async () => {
  for (const code of ['NETWORK', 'TIMEOUT', 'NOT_CONNECTED']) {
    const f = fixture(); await f.conversation.start(); await f.conversation.open('1');
    f.setError(Object.assign(new Error('fixture unavailable'), { code }));
    await assert.rejects(f.conversation.refresh());
    assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['10']);
    f.setError(); f.setRows([m(11)]); await f.conversation.refresh();
    assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['11']);
    assert.equal(f.conversation.live, true); assert.equal(f.conversation.readError, undefined);
  }
});

test('events during an in-flight update are drained without idle reads or duplicate messages', async () => {
  const f = fixture(); let notify!: () => void, unsubscribe = 0, updates = 0;
  f.reader.watch = async (_room, changed) => { notify = changed; return () => { unsubscribe++; }; };
  f.reader.updates = async () => { updates++; return { messages: [m(11)], removedIds: [], reset: false, cursor: 1 }; };
  await f.conversation.start(); await f.conversation.open('1');
  await new Promise(resolve => setImmediate(resolve));
  const idle = updates; await new Promise(resolve => setImmediate(resolve)); assert.equal(updates, idle);
  let finish!: (value: any) => void;
  f.reader.updates = () => { updates++; return new Promise(resolve => { finish = resolve; }); };
  notify(); notify();
  f.reader.updates = async () => { updates++; return { messages: [m(12)], removedIds: [], reset: false, cursor: 3 }; };
  notify(); finish({ messages: [m(11), m(12)], removedIds: [], reset: false, cursor: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['10', '11', '12']);
  assert.equal(updates, idle + 2);
  f.conversation.close(); assert.equal(unsubscribe, 1);
  notify(); await new Promise(resolve => setImmediate(resolve)); assert.equal(updates, idle + 2);
});

test('bounded update pages drain completely after one event', async () => {
  const f = fixture(); let notify!: () => void, calls = 0;
  f.reader.watch = async (_room, changed) => { notify = changed; return () => {}; };
  f.reader.updates = async () => ({ messages: [], removedIds: [], reset: false, cursor: 0 });
  await f.conversation.start(); await f.conversation.open('1'); await new Promise(resolve => setImmediate(resolve));
  f.reader.updates = async () => { calls++; return { messages: [m(10 + calls)], removedIds: [], reset: false, cursor: calls, more: calls < 3 }; };
  notify(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3); assert.deepEqual(f.conversation.messages.map(m => m.messageId), ['10', '11', '12', '13']); f.conversation.close();
});
