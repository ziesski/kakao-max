import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from './commands.ts';
import { HELP_CATEGORIES, helpNames, renderCommand, renderOverview, suggest } from './help.ts';

test('the overview lists every command exactly once, in a category', () => {
  const listed = HELP_CATEGORIES.flatMap(([, names]) => names);
  assert.equal(new Set(listed).size, listed.length, 'no command is listed twice');
  const known = new Set(helpNames().values());
  assert.deepEqual(new Set(listed), known, 'every built-in and daemon tool command has a category');
  for (const name of Object.keys(COMMANDS)) assert.ok(listed.includes(name), name);
  const overview = renderOverview();
  for (const name of listed) assert.match(overview, new RegExp(`^  ${name} `, 'm'));
});

test('per-command help resolves aliases and shows usage, group and options', () => {
  assert.match(renderCommand('hist')!, /^kakao history/);
  assert.match(renderCommand('dl')!, /--type photo\|video\|audio\|file/);
  const leave = renderCommand('leave')!;
  assert.match(leave, /사용법: kakao leave <대화방>/);
  assert.match(leave, /묶음:\s+chats/);
  assert.match(leave, /--silent\n/);
  assert.equal(renderCommand('nope'), undefined);
});

test('typos suggest the closest commands', () => {
  assert.deepEqual(suggest('sned'), ['send']);
  assert.deepEqual(suggest('vault'), ['vault-export', 'vault-links', 'vault-schedule']);
  assert.deepEqual(suggest('zzzzzzzz'), []);
});
