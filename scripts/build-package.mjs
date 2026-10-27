#!/usr/bin/env node
// Build the published package: one self-contained ESM bundle per program in dist/, so an installed package
// runs plain JavaScript (Node does not strip types inside node_modules) and needs no runtime dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
// Keep in step with PROGRAM_SOURCES in packages/core/src/entry.ts.
const programs = {
  cli: 'apps/cli/src/index.ts',
  mcp: 'apps/mcp/src/index.ts',
  web: 'apps/web/src/index.ts',
  setup: 'apps/mcp/src/setup.ts',
  'setup-system': 'apps/mcp/src/setup-system.ts',
  'update-managed': 'apps/mcp/src/update-managed.ts',
  connect: 'apps/mcp/src/connect.ts',
  healthcheck: 'apps/mcp/src/healthcheck.ts',
  register: 'apps/mcp/src/register.ts',
  approver: 'apps/mcp/src/approver.ts',
};

execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', path.join(root, 'packages/protocol')], { stdio: 'inherit' });
fs.rmSync(dist, { recursive: true, force: true });
for (const [name, source] of Object.entries(programs)) {
  await build({
    entryPoints: [path.join(root, source)], outfile: path.join(dist, `${name}.mjs`),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node:*'],
    define: { __KAKAO_MAX_ENTRY__: JSON.stringify(name) }, legalComments: 'eof', logLevel: 'warning',
    // Bundled CommonJS (the protocol build, bson) still calls require() for Node built-ins.
    banner: { js: "import { createRequire as __kakaoMaxRequire } from 'node:module';\nconst require = __kakaoMaxRequire(import.meta.url);" },
  });
  // esbuild keeps an entry's own hashbang first; add one where the source has none.
  const out = path.join(dist, `${name}.mjs`), code = fs.readFileSync(out, 'utf8');
  if (!code.startsWith('#!')) fs.writeFileSync(out, `#!/usr/bin/env node\n${code}`);
  fs.chmodSync(out, 0o755);
}
fs.cpSync(path.join(root, 'apps/web/public'), path.join(dist, 'web-public'), { recursive: true });
const bsonDir = path.join(root, 'node_modules/bson');
const bson = JSON.parse(fs.readFileSync(path.join(bsonDir, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dist, 'THIRD-PARTY-NOTICES.txt'),
  `The bundles in this directory include bson ${bson.version} (${bson.license}), https://github.com/mongodb/js-bson\n\n${fs.readFileSync(path.join(bsonDir, 'LICENSE.md'), 'utf8')}`);
process.stdout.write(`Built ${Object.keys(programs).length} programs into dist/\n`);
