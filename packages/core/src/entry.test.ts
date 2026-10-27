import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRoot, isMainModule, packagedEntry, programArgs, setupCommand, PROGRAM_SOURCES } from './entry.ts';

test('a source checkout starts programs from TypeScript and names npm in messages', () => {
  assert.equal(packagedEntry(), undefined);
  const root = installRoot();
  assert.deepEqual(programArgs('connect'), ['--experimental-strip-types', path.join(root, 'apps/mcp/src/connect.ts')]);
  assert.deepEqual(programArgs('mcp', { relative: true }), ['--experimental-strip-types', 'apps/mcp/src/index.ts']);
  assert.equal(setupCommand('--doctor'), 'npm run setup -- --doctor');
  assert.equal(setupCommand(), 'npm run setup');
  assert.equal(isMainModule(pathToFileURL(path.join(root, PROGRAM_SOURCES.setup)).href, 'setup'), false);
});

test('the package layout starts dist bundles with plain node', () => {
  assert.deepEqual(programArgs('connect', { packaged: true, root: '/opt/kakao-max' }), [path.join('/opt/kakao-max', 'dist', 'connect.mjs')]);
  assert.deepEqual(programArgs('mcp', { packaged: true, relative: true }), ['dist/mcp.mjs']);
});
