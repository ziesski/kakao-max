#!/usr/bin/env node
// Call one MCP tool on the daemon and print the result (for checks and debugging).
//
//   node scripts/mcp-call.mjs <tool> ['<json args>']
//   node scripts/mcp-call.mjs get_unread_summary
//   node scripts/mcp-call.mjs get_history '{"chatId":"<id>","limit":5}'
//
// Talks to MCP_HOST:MCP_PORT (default 127.0.0.1:8787, e.g. an SSH tunnel to the daemon's server).
// Write tools still go through the daemon's policy; only call them with the user's approval.
import net from 'node:net';

const [tool, argsJson = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/mcp-call.mjs <tool> ['<json args>']");
  process.exit(2);
}
const host = process.env.MCP_HOST || '127.0.0.1';
const port = Number(process.env.MCP_PORT || 8787);
const sock = net.connect(port, host);
let buf = '';
sock.on('error', (e) => {
  console.error(`cannot reach the MCP daemon at ${host}:${port}: ${e.message}`);
  process.exit(1);
});
sock.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.id !== 2) continue;
    if (msg.error) {
      console.error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
      process.exit(1);
    }
    const text = msg.result?.content?.[0]?.text ?? '';
    sock.end();
    // Exit only after stdout drains: a piped stdout is async, and exiting early truncates big results.
    process.stdout.write(text + '\n', () => process.exit(msg.result?.isError ? 1 : 0));
  }
});
sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: JSON.parse(argsJson) } }) + '\n');
