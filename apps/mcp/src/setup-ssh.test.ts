// Opt-in two-channel SSH test of the generated connection settings, without any Kakao credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connectionConfig } from './setup.ts';

const flag = process.argv.indexOf('--ssh-fixture');
test('generated SSH stdio config carries discover, prepare, elicitation retry and a fixture acknowledgement', { skip: flag === -1, timeout: 40000 }, async t => {
  const host = process.argv[flag + 1], repo = process.argv[flag + 2];
  connectionConfig({ ssh: host }); assert.match(repo, /^\/[A-Za-z0-9_./-]+$/);
  const q = (s: string) => `'${s.replace(/'/g, `'\''`)}'`;
  const command = ['node', '--experimental-strip-types', path.join(repo, 'apps/mcp/src/setup-linux.test.ts'), '--serve-ssh-fixture'].map(q).join(' ');
  const control = spawn('ssh', ['-T','-o','BatchMode=yes','-o','ConnectTimeout=10',host,command]);
  let controlErr = ''; control.stderr.on('data', c => { controlErr += c.toString(); });
  t.after(() => { control.stdin.end(); control.kill(); });
  const ready = await new Promise<{ fixturePort: number }>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('SSH fixture readiness timed out')), 15000);
    control.once('exit', code => { clearTimeout(timer); reject(new Error(`SSH fixture exited ${code}: ${controlErr}`)); });
    control.stdout.on('data', c => { text += c.toString(); const end = text.indexOf('\n'); if (end !== -1) { clearTimeout(timer); try { resolve(JSON.parse(text.slice(0, end))); } catch (e) { reject(e); } } });
  });
  assert.ok(Number.isInteger(ready.fixturePort) && ready.fixturePort > 1024 && ready.fixturePort < 65536);
  const config = connectionConfig({ ssh: host, listen: `127.0.0.1:${ready.fixturePort}` }).mcpServers['kakao-max'];
  const client = spawn(config.command, config.args); t.after(() => { client.stdin.end(); client.kill(); });
  let buffer = '', id = 0, clientErr = '';
  client.stderr.on('data', c => { clientErr += c.toString(); });
  const waiting = new Map<number, (value: any) => void>();
  client.stdout.on('data', c => { buffer += c.toString(); let n;
    while ((n = buffer.indexOf('\n')) !== -1) { const r = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); waiting.get(r.id)?.(r.result); waiting.delete(r.id); }
  });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'ssh-os-fixture', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
  const call = (method: string, params: object = {}) => new Promise<any>(resolve => {
    const next = ++id; waiting.set(next, resolve); client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params: { _meta: meta, ...params } }) + '\n');
  });
  assert.equal((await call('server/discover')).resultType, 'complete');
  const args = { requestId: randomUUID(), chatId: '123456789', text: 'fixture UTF-8 메시지' };
  assert.equal(JSON.parse((await call('tools/call', { name: 'prepare_message', arguments: args })).content[0].text).approvalRequired, true);
  const ask = await call('tools/call', { name: 'send_message', arguments: args }); assert.equal(ask.resultType, 'input_required');
  const code = /확인 코드 ([A-Z2-9]{4})/.exec(ask.inputRequests.approve.params.message)![1];
  const result = await call('tools/call', { name: 'send_message', arguments: args, requestState: ask.requestState,
    inputResponses: { approve: { action: 'accept', content: { code } } } });
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).state, 'sent_unverified');
  const clientExit = once(client, 'exit'), controlExit = once(control, 'exit'); client.stdin.end();
  assert.equal((await clientExit)[0], 0, clientErr); assert.equal((await controlExit)[0], 0, controlErr);
  console.log('SSH -W: MCP/MRTR round-trip completed; exactly one fake adapter call and no Kakao connection.');
});
