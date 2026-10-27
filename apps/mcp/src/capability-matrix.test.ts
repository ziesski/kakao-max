import { NAMED_OPERATION_TOOLS } from './tools/agent-operations.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps docs/agent-capability-matrix.md honest: every registered MCP tool must
// appear there (in backticks), and the matrix must not list tools that no longer exist.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
// Tools live in index.ts and in tools/*.ts (one file per area).
const toolsDir = path.join(here, 'tools');
const toolFiles = fs.existsSync(toolsDir)
  ? fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(toolsDir, f))
  : [];
// Installed optional modules (packages/*/src/mcp.ts) register their tools too; a build without one has no rows for it.
const packagesDir = path.join(root, 'packages');
const moduleFiles = fs.readdirSync(packagesDir).map((p) => path.join(packagesDir, p, 'src', 'mcp.ts')).filter((f) => fs.existsSync(f));
const moduleSource = moduleFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const source = [path.join(here, 'index.ts'), ...toolFiles]
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n') + '\n' + moduleSource;
const OPTIONAL_MODULES: string[] = [];
const moduleNamed = [...moduleSource.matchAll(/\{ name: '(\w+)', group: '/g)].map((m) => m[1]);
const matrix = fs.readFileSync(path.join(root, 'docs', 'agent-capability-matrix.md'), 'utf8');

// Named operation tools are registered in a loop, so they come from their exported list.
const tools = [...NAMED_OPERATION_TOOLS, ...moduleNamed, ...[...source.matchAll(/server\.registerTool\(\{\n\s+name: '(\w+)'/g)].map((m) => m[1])];

test('every MCP tool is listed in the capability matrix', () => {
  assert.ok(tools.length > 20, 'found the tool registrations');
  const missing = tools.filter((t) => !matrix.includes('`' + t + '`') && !matrix.includes('`' + t + ' '));
  assert.deepEqual(missing, [], `add these tools to docs/agent-capability-matrix.md: ${missing.join(', ')}`);
});

test('the capability matrix does not list removed tools', () => {
  const tableTools = new Set<string>();
  for (const line of matrix.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // The tool column starts with the tool name; later backticks are argument names.
    const first = (cells[2] ?? '').match(/^`([a-z_]+)`/);
    if (first) tableTools.add(first[1]);
  }
  // Rows of an optional module that is not installed here (its tool names carry the module name) are not stale.
  const absent = OPTIONAL_MODULES.filter((m) => !fs.existsSync(path.join(packagesDir, m, 'src', 'mcp.ts')));
  const stale = [...tableTools].filter((t) => !tools.includes(t) && !absent.some((m) => t.includes(m)));
  assert.deepEqual(stale, [], `tools in the matrix but not registered: ${stale.join(', ')}`);
});
