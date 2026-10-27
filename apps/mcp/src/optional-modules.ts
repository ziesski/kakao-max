// Optional feature modules. Core never imports them; this daemon loads one only
// when its package is installed, so a build without the folder simply has no such tools or operations.
// A module adds tools in its own group, approved operations with their definitions, and approval labels.
// It reaches account state only through the session's own policy paths (KakaoSession.extensionHost).
import { KakaoError, registerReadGrantTool, type AgentOperationDefinition, type AgentOperationEngine, type AgentOperationEngineAdapter, type KakaoSession } from '@kakao-max/core';
import type { McpStdioServer } from './mcp-stdio.ts';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from './untrusted.ts';
import { readGrant } from './read-grant.ts';
import { registerNamedOperationTools, type NamedOperation } from './tools/agent-operations.ts';
import { registerApprovalLabels } from './client-approval.ts';

/** What the daemon hands a module: its session and the shared tool helpers, so the module needs no app imports. */
export interface OptionalModuleContext {
  kakao: KakaoSession;
  markUntrusted: typeof markUntrusted;
  untrustedNote: string;
  readGrant: typeof readGrant;
}
export interface OptionalMcpModule {
  /** The KAKAO_MCP_TOOL_GROUPS name that lists this module's tools. */
  group: string;
  registerTools(server: McpStdioServer): void;
  operations: readonly AgentOperationDefinition[];
  /** Named tools for `operations`, each one call with a stable requestId and human approval. */
  namedOperations: readonly NamedOperation[];
  inspect: AgentOperationEngineAdapter['inspect'];
  /** Approval dialog and passkey page names for `operations`. */
  labels: Record<string, string>;
  /** Read tools a one-time read grant may name. */
  readGrantTools: readonly string[];
}
export type OptionalModuleFactory = (ctx: OptionalModuleContext) => OptionalMcpModule;

// Package specifiers to try at startup; this source release ships none.
const KNOWN: readonly string[] = [];

/** Import the installed optional modules. A missing package is skipped; any other load failure stops startup. */
export async function loadOptionalModules(kakao: KakaoSession, specifiers: readonly string[] = KNOWN): Promise<OptionalMcpModule[]> {
  const loaded: OptionalMcpModule[] = [];
  for (const specifier of specifiers) {
    let factory: OptionalModuleFactory;
    try { factory = (await import(specifier) as { default: OptionalModuleFactory }).default; }
    catch (e) {
      const err = e as NodeJS.ErrnoException;
      if ((err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') && String(err.message).includes(specifier.split('/').slice(0, 2).join('/'))) continue;
      throw e;
    }
    loaded.push(factory({ kakao, markUntrusted, untrustedNote: UNTRUSTED_TOOL_NOTE, readGrant }));
  }
  return loaded;
}

/** Register loaded modules' tools, labels and read-grant names. Their operations go to the engine separately. */
export function registerOptionalModules(server: McpStdioServer, modules: readonly OptionalMcpModule[], engine: () => AgentOperationEngine): void {
  for (const m of modules) {
    m.registerTools(server);
    registerNamedOperationTools(server, engine, m.namedOperations);
    registerApprovalLabels(m.labels);
    for (const tool of m.readGrantTools) registerReadGrantTool(tool);
  }
}

/** An enabled tool group must be built in or come from a loaded module. */
export function checkToolGroups(enabled: readonly string[], builtIn: readonly string[], modules: readonly OptionalMcpModule[]): void {
  const known = new Set([...builtIn, ...modules.map(m => m.group)]);
  const missing = enabled.filter(g => !known.has(g));
  if (missing.length) throw new KakaoError('CONFIG_INVALID', `KAKAO_MCP_TOOL_GROUPS names groups that are not available here (${missing.join(', ')}); ` +
    `choose from ${[...known].join(', ')}. An optional module's group needs its package installed`);
}
