import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMMANDS, parseCommand, type CliContext } from './commands.ts';

const REQUEST = '00000000-0000-4000-8000-000000000001';
type Call = { via: 'call' | 'write'; tool: string; args: Record<string, unknown>; kind?: string };

async function run(line: string[], reply: unknown = { ok: true }): Promise<Call[]> {
  const calls: Call[] = [];
  const cli: CliContext = {
    requestId: REQUEST,
    call: async (tool, args = {}) => { calls.push({ via: 'call', tool, args }); return reply as any; },
    write: async (tool, args, kind) => { calls.push({ via: 'write', tool, args, kind }); return reply; },
    room: async target => ({ fixture: '123456789', other: '987654321' } as Record<string, string>)[target] ?? Promise.reject(new Error('no room'))
  };
  const { command, args, values } = parseCommand(line[0], line.slice(1));
  await command.run(cli, args, values);
  return calls;
}

// Every command, with the exact tool call it must make. Approved writes go through write(); reads and
// immediate narrowing (revoke, pause, hide, room-default) are plain calls.
const CASES: Array<[string[], Call]> = [
  [['find-room', 'team', '--participant', 'a', '--participant', 'b', '--members', '3'], { via: 'call', tool: 'find_chat', args: { query: 'team', participants: ['a', 'b'], memberCount: 3 } }],
  [['dm', 'fixture-friend'], { via: 'call', tool: 'open_direct_chat', args: { query: 'fixture-friend' } }],
  [['members', 'fixture', '111', '222'], { via: 'call', tool: 'get_members', args: { chatId: '123456789', userIds: ['111', '222'] } }],
  [['meta', 'fixture', '1'], { via: 'call', tool: 'get_chat_meta', args: { chatId: '123456789', types: [1] } }],
  [['unread', 'fixture', '--read-grant', 'g1', '--limit', '5'], { via: 'call', tool: 'preview_unread', args: { chatId: '123456789', readGrantId: 'g1', limit: 5 } }],
  [['sync-friends'], { via: 'call', tool: 'sync_friends', args: {} }],
  [['blocked', '--no-resolve'], { via: 'call', tool: 'list_blocked_users', args: { resolveMembers: false } }],
  [['profile'], { via: 'call', tool: 'get_my_profile', args: {} }],
  [['friend-profile', '111'], { via: 'call', tool: 'get_friend_profile', args: { userId: '111' } }],
  [['perms'], { via: 'call', tool: 'list_permissions', args: {} }],
  [['revoke', 'recipient:123456789'], { via: 'call', tool: 'revoke_permission', args: { permissionId: 'recipient:123456789' } }],
  [['allow', 'fixture'], { via: 'write', tool: 'request_permission', args: { chatId: '123456789', type: 'send' }, kind: 'operation' }],
  [['allow-read', 'fixture', '--tools', 'read_messages, download_attachment', '--uses', '2'],
    { via: 'write', tool: 'request_permission', args: { chatId: '123456789', type: 'read', tools: ['read_messages', 'download_attachment'], uses: 2 }, kind: 'operation' }],
  [['room-rule', 'fixture', 'manual', '--max', '20'],
    { via: 'write', tool: 'request_permission', args: { chatId: '123456789', type: 'room_access', rule: { mode: 'manual', maxMessages: 20 } }, kind: 'operation' }],
  [['room-default', 'fixture'], { via: 'call', tool: 'request_permission', args: { requestId: REQUEST, chatId: '123456789', type: 'room_default' } }],
  [['pause'], { via: 'call', tool: 'pause', args: { paused: true } }],
  [['wait', REQUEST, '--timeout', '1000'], { via: 'call', tool: 'wait_for_approval', args: { requestId: REQUEST, timeoutMs: 1000 } }],
  [['op', REQUEST], { via: 'call', tool: 'get_operation', args: { requestId: REQUEST } }],
  [['edit', 'fixture', '42', 'new', 'text'], { via: 'write', tool: 'edit_or_delete_message', args: { action: 'edit', chatId: '123456789', logId: '42', text: 'new text' }, kind: 'mutation' }],
  [['delete', 'fixture', '42'], { via: 'write', tool: 'edit_or_delete_message', args: { action: 'delete', chatId: '123456789', logId: '42' }, kind: 'mutation' }],
  [['hide', 'fixture', '42', '43'], { via: 'call', tool: 'self_delete_messages', args: { chatId: '123456789', logIds: ['42', '43'] } }],
  [['forward', 'fixture', 'hello', '--type', '1'], { via: 'write', tool: 'forward_message', args: { chatId: '123456789', text: 'hello', type: 1 }, kind: 'send' }],
  [['emoticon', 'fixture', 'other', '42'], { via: 'write', tool: 'send_emoticon', args: { chatId: '123456789', fromChatId: '987654321', fromLogId: '42' }, kind: 'mutation' }],
  [['set-meta', 'fixture', '1', 'notice', 'text'], { via: 'write', tool: 'set_chat_meta', args: { chatId: '123456789', type: 1, content: 'notice text' }, kind: 'operation' }],
  [['leave', 'fixture', '--silent'], { via: 'write', tool: 'leave_chat', args: { chatId: '123456789', silence: true }, kind: 'operation' }],
  [['create-dm', '111'], { via: 'write', tool: 'create_direct_chat', args: { userId: '111' }, kind: 'operation' }],
  [['add-friend', '111'], { via: 'write', tool: 'add_friend', args: { userId: '111' }, kind: 'operation' }],
  [['block', '111', '--profile'], { via: 'write', tool: 'block_user', args: { userId: '111', blockType: 2 }, kind: 'operation' }],
  [['unblock', '111'], { via: 'write', tool: 'unblock_user', args: { userId: '111' }, kind: 'operation' }],
  [['status-message', 'p1', ''], { via: 'write', tool: 'update_my_profile', args: { profileId: 'p1', statusMessage: '' }, kind: 'mutation' }],
  [['events-claim', 'fixture', '--consumer', 'w1', '--limit', '10'], { via: 'call', tool: 'claim_message_events', args: { chatId: '123456789', consumer: 'w1', limit: 10 } }],
  [['events-ack', 'fixture', '--consumer', 'w1', '--generation', 'g', 'e1:l1', 'e2:l2'],
    { via: 'call', tool: 'ack_message_events', args: { chatId: '123456789', consumer: 'w1', sourceGeneration: 'g', events: [{ eventId: 'e1', leaseId: 'l1' }, { eventId: 'e2', leaseId: 'l2' }] } }],
  [['vault-export', 'fixture', 'html', '--title', 't'], { via: 'call', tool: 'export_chat_history', args: { chatId: '123456789', format: 'html', title: 't' } }],
  [['vault-links', 'fixture'], { via: 'call', tool: 'collect_shared_links', args: { chatId: '123456789' } }],
  [['vault-schedule', 'fixture', '--limit', '100'], { via: 'call', tool: 'extract_schedule_and_todos', args: { chatId: '123456789', limit: 100 } }],
  [['vault-search', 'word', 'fixture', 'other'], { via: 'call', tool: 'search_vault', args: { chatIds: ['123456789', '987654321'], query: 'word' } }],
  [['vault-stats'], { via: 'call', tool: 'get_vault_stats', args: {} }]
];

test('every command makes exactly its one daemon tool call with the exact arguments', async () => {
  assert.deepEqual(new Set(CASES.map(([line]) => line[0]).filter(n => n !== 'resume')), new Set(Object.keys(COMMANDS).filter(n => n !== 'resume')),
    'each command has a case');
  for (const [line, expected] of CASES) {
    const calls = await run(line);
    assert.deepEqual(calls, [expected], line.join(' '));
  }
});

test('every tool a command uses is registered by the daemon', () => {
  const dir = new URL('../../mcp/src/tools/', import.meta.url);
  const source = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const registered = new Set([...source.matchAll(/name: '([a-z_]+)'/g)].map(m => m[1]));
  for (const [line, { tool }] of CASES) assert.ok(registered.has(tool), `${line[0]} -> ${tool}`);
});

test('resume asks for approval until the daemon reports sending is released', async () => {
  await assert.rejects(run(['resume'], { paused: true }), { code: 'APPROVAL_REQUIRED', message: new RegExp(REQUEST) });
  assert.deepEqual(await run(['resume'], { paused: false }), [{ via: 'call', tool: 'pause', args: { paused: false, requestId: REQUEST } }]);
});

test('arguments are strict: unknown flags, missing positionals and malformed IDs never reach the daemon', async () => {
  assert.throws(() => parseCommand('allow', ['fixture', '--force']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseCommand('edit', ['fixture', '42']), { code: 'INVALID_ARGUMENT', message: /사용법/ });
  assert.throws(() => parseCommand('allow', ['fixture', '--request-id', 'not-a-uuid']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseCommand('nope', []), { code: 'INVALID_ARGUMENT' });
  assert.equal(parseCommand('allow', ['fixture', '--request-id', REQUEST]).requestId, REQUEST);
  for (const line of [['block', '12ab'], ['members', 'fixture', 'x'], ['find-room', '--members', '2.5'], ['unread', 'fixture'],
    ['events-ack', 'fixture', '--consumer', 'w', '--generation', 'g', 'no-lease'], ['room-rule', 'fixture', 'manual', '--schedule', '{bad']]) {
    await assert.rejects(run(line), { code: 'INVALID_ARGUMENT' }, line.join(' '));
  }
});
