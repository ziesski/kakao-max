import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpStdioServer } from './mcp-stdio.ts';

// When this file is executed with MCP_TEST_CHILD=1 it runs AS the server (so the test
// can spawn itself as a subprocess and drive the real stdio transport end to end).
if (process.env.MCP_TEST_CHILD === '1') {
  const s = new McpStdioServer({ name: 'test', version: '0.0.1', instructions: 'be careful' });
  s.registerTool({
    name: 'echo',
    description: 'echo back',
    inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
    handler: (a) => ({ echoed: a.v })
  });
  s.registerTool({
    name: 'strict',
    description: 'validated args',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { chatId: { type: 'string' }, limit: { type: 'number' }, filter: { type: 'string', enum: ['all', 'direct'] } },
      required: ['chatId'],
      additionalProperties: false
    },
    handler: (a) => ({ ok: true, limit: a.limit })
  });
  s.registerTool({
    name: 'boom',
    description: 'throws',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      throw new Error('kaboom');
    }
  });
  s.listen();
} else {
  const self = fileURLToPath(import.meta.url);

  /** Send each request (objects are JSON-encoded, strings are written raw) and collect replies. */
  function drive(requests: Array<object | string>): Promise<Record<string, any>[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', self], {
        env: { ...process.env, MCP_TEST_CHILD: '1' },
        stdio: ['pipe', 'pipe', 'inherit']
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.on('error', reject);
      child.on('close', () => {
        const lines = out.split('\n').filter((l) => l.trim());
        try {
          resolve(lines.map((l) => JSON.parse(l)));
        } catch (e) {
          reject(e);
        }
      });
      for (const r of requests) child.stdin.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n');
      child.stdin.end();
    });
  }

  test('MCP stdio: initialize, tools/list, tools/call, error, ping', async () => {
    const replies = await drive([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'ping' }
    ]);

    const byId = new Map<number, Record<string, any>>(replies.map((r) => [r.id as number, r]));
    const must = (id: number): Record<string, any> => {
      const r = byId.get(id);
      assert.ok(r, `no reply for id ${id}`);
      return r;
    };
    // notifications/initialized has no id → must produce no reply (5 replies, not 6).
    assert.equal(replies.length, 5);

    const init = must(1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.capabilities.tools.listChanged, false);

    const list = must(2);
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name).sort(),
      ['boom', 'echo', 'strict']
    );

    const echo = must(3);
    assert.equal(echo.result.isError, false);
    assert.deepEqual(JSON.parse(echo.result.content[0].text), { echoed: 'hi' });

    const boom = must(4);
    assert.equal(boom.result.isError, true);
    assert.match(boom.result.content[0].text, /^Error \[INTERNAL\]: Unexpected internal error/);
    assert.equal(JSON.stringify(boom).includes('kaboom'), false);
    assert.equal(boom.result.structuredContent.error.code, 'INTERNAL');
    assert.equal(boom.result.structuredContent.error.retryable, false);

    assert.deepEqual(must(5).result, {});
  });

  test('MCP stdio: unknown method returns JSON-RPC error', async () => {
    const [reply] = await drive([{ jsonrpc: '2.0', id: 9, method: 'nope/nope' }]);
    assert.equal(reply.id, 9);
    assert.equal(reply.error.code, -32601);
  });

  test('MCP stdio: initialize returns instructions; tools/list carries annotations', async () => {
    const replies = await drive([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ]);
    const init = replies.find((r) => r.id === 1)!;
    assert.equal(init.result.instructions, 'be careful');
    const strict = replies.find((r) => r.id === 2)!.result.tools.find((t: any) => t.name === 'strict');
    assert.deepEqual(strict.annotations, { readOnlyHint: true, openWorldHint: false });
  });

  test('MCP stdio: JSON-RPC envelope errors (parse, batch, invalid request)', async () => {
    const replies = await drive([
      '{not json',
      [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
      { id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 42 },
      { jsonrpc: '2.0', id: 4, result: {} },
      { jsonrpc: '2.0', method: 'notifications/unknown' },
      { jsonrpc: '2.0', id: 5, method: 'ping' }
    ]);
    // parse error, batch, missing jsonrpc, null id, non-string method → 5 errors; the
    // client response and the unknown notification get no reply; ping answers.
    assert.equal(replies.length, 6);
    assert.deepEqual(replies[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    assert.equal(replies[1].error.code, -32600);
    assert.equal(replies[2].error.code, -32600);
    assert.equal(replies[2].id, 2);
    assert.equal(replies[3].error.code, -32600);
    assert.equal(replies[3].id, null);
    assert.equal(replies[4].error.code, -32600);
    assert.equal(replies[4].id, 3);
    assert.deepEqual(replies[5], { jsonrpc: '2.0', id: 5, result: {} });
  });

  test('MCP stdio: tool arguments are validated against inputSchema', async () => {
    const replies = await drive([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'strict', arguments: { limit: 'x', filter: 'nope', extra: 1 } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'strict', arguments: { chatId: 'c', limit: '20' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 7 } }
    ]);
    const bad = replies.find((r) => r.id === 1)!.result;
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(bad.structuredContent.error.details.problems.sort(), [
      '"chatId" is required',
      '"filter" must be one of "all", "direct"',
      '"limit" must be number',
      'unknown argument "extra"'
    ]);
    const ok = replies.find((r) => r.id === 2)!.result;
    assert.equal(ok.isError, false, 'numeric strings are accepted for number');
    assert.equal(replies.find((r) => r.id === 3)!.error.code, -32602);
  });
}
