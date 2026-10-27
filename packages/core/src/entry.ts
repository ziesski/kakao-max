// Which program is running and how to start the others: a source checkout (`node --experimental-strip-types
// <file>.ts`) or one bundle of the published package (`dist/<name>.mjs`). The package build defines
// __KAKAO_MAX_ENTRY__ per bundle; a bundle holds several modules that share one import.meta.url, so a URL
// comparison alone would start every program in it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __KAKAO_MAX_ENTRY__: string | undefined;

/** Programs a source checkout runs from TypeScript and the package ships as `dist/<name>.mjs`. */
export const PROGRAM_SOURCES = {
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
} as const;
export type ProgramName = keyof typeof PROGRAM_SOURCES;

/** The bundle name in the published package, or undefined in a source checkout. */
export function packagedEntry(): string | undefined {
  return typeof __KAKAO_MAX_ENTRY__ === 'string' ? __KAKAO_MAX_ENTRY__ : undefined;
}

/** True when this module's program was started directly (not imported by a test or another program). */
export function isMainModule(moduleUrl: string, name: ProgramName): boolean {
  const entry = packagedEntry();
  if (entry !== undefined) return entry === name;
  return !!process.argv[1] && fileURLToPath(moduleUrl) === process.argv[1];
}

/** The checkout or package root: `dist/..` in the package, three levels above this file in a checkout. */
export function installRoot(packaged = packagedEntry() !== undefined): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, packaged ? '..' : '../../..');
}

/** Node arguments that start `name` from `root`; relative to `root` when `relative` is set. */
export function programArgs(name: ProgramName, opts: { root?: string; packaged?: boolean; relative?: boolean } = {}): string[] {
  const packaged = opts.packaged ?? packagedEntry() !== undefined;
  const file = packaged ? path.join('dist', `${name}.mjs`) : PROGRAM_SOURCES[name];
  const target = opts.relative ? file.split(path.sep).join('/') : path.join(opts.root ?? installRoot(packaged), file);
  return packaged ? [target] : ['--experimental-strip-types', target];
}

/** How a person runs the setup wizard here, for messages: `kakao-max setup` from the package, npm in a checkout. */
export function setupCommand(args = ''): string {
  if (packagedEntry() !== undefined) return args ? `kakao-max setup ${args}` : 'kakao-max setup';
  return args ? `npm run setup -- ${args}` : 'npm run setup';
}
