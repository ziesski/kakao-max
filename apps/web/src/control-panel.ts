import { isRequestId, writeFailure, MISSING_REQUEST_ID, NOT_CONNECTED } from './write-request.ts';

// ----------------------------------------------------------------------------
// The person's control panel for the account the agent uses, built only from
// existing daemon tools: get_status (display only: no tool changes the agent
// mode), pause (true at once; false asks the person through the daemon's own
// dialog, which this GUI relays), list_permissions and revoke_permission
// (narrowing, immediate). It never fills in a confirmation code.
// ----------------------------------------------------------------------------

export interface ToolCaller {
  readonly isConnected: boolean;
  callTool<T = any>(name: string, args?: Record<string, any>): Promise<T>;
}

export interface ControlStatus {
  connected: boolean;
  /** Daemon's account connection (may differ from this GUI's connection to the daemon). */
  accountConnected: boolean | null;
  agentMode: { mode: string; source: string | null } | null;
  paused: boolean | null;
  approvalMethods: { clientDialog: boolean; passkeyPage: boolean } | null;
  toolGroups: string[];
}

export interface PermissionItem {
  /** What revoke_permission takes. */
  permissionId: string;
  kind: 'send' | 'read-rule' | 'read-grant';
  chatId: string;
  /** Short, content-free description (rule mode, daily use, expiry). */
  detail: string;
}

/** Only the fields the panel shows; the rest of get_status (paths, limits) stays out of the page. */
export function controlStatus(raw: any, connected: boolean): ControlStatus {
  const mode = raw?.agentMode;
  const methods = raw?.approvalMethods;
  return {
    connected,
    accountConnected: typeof raw?.connected === 'boolean' ? raw.connected : null,
    agentMode: mode && typeof mode.mode === 'string' ? { mode: mode.mode, source: typeof mode.source === 'string' ? mode.source : null } : null,
    paused: typeof raw?.policy?.paused === 'boolean' ? raw.policy.paused : null,
    approvalMethods: methods ? { clientDialog: methods.clientDialog === true, passkeyPage: methods.passkeyPage === true } : null,
    toolGroups: Array.isArray(raw?.toolGroups) ? raw.toolGroups.filter((g: unknown) => typeof g === 'string') : []
  };
}

/** Flatten list_permissions into one revocable list. */
export function permissionItems(raw: any): PermissionItem[] {
  const items: PermissionItem[] = [];
  for (const p of Array.isArray(raw?.sendRooms) ? raw.sendRooms : []) {
    if (typeof p?.grantId !== 'string') continue;
    const limit = typeof p.dailyLimit === 'number' ? `오늘 ${Number(p.usedToday) || 0}/${p.dailyLimit}` : `오늘 ${Number(p.usedToday) || 0}회`;
    items.push({ permissionId: p.grantId, kind: 'send', chatId: String(p.chatId ?? ''), detail: `묻지 않고 보내기 · ${limit}` });
  }
  for (const r of Array.isArray(raw?.readRooms) ? raw.readRooms : []) {
    if (typeof r?.permissionId !== 'string') continue;
    const mode = typeof r.rule?.mode === 'string' ? r.rule.mode : '?';
    const until = typeof r.rule?.expiresAt === 'string' ? ` · ${r.rule.expiresAt}까지` : '';
    items.push({ permissionId: r.permissionId, kind: 'read-rule', chatId: String(r.chatId ?? ''), detail: `읽기 규칙 ${mode}${until}` });
  }
  for (const g of Array.isArray(raw?.readGrants) ? raw.readGrants : []) {
    if (typeof g?.grantId !== 'string' || g.revoked === true) continue;
    const until = typeof g.expiresAt === 'number' ? ` · ${new Date(g.expiresAt).toISOString()} 만료` : '';
    items.push({ permissionId: g.grantId, kind: 'read-grant', chatId: String(g.chatId ?? ''), detail: `일회성 읽기 ${Number(g.usesLeft) || 0}회 남음${until}` });
  }
  return items;
}

/** recipient:<chatId>, room:<chatId> or a read grant UUID. */
const PERMISSION_ID = /^(?:(?:recipient|room):[0-9A-Za-z_-]{1,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export function isPermissionId(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_ID.test(value);
}

export interface RouteResult { status: number; body: unknown }

/**
 * The panel's API. `GET /api/control` reads; the POSTs act. Called after the server's shared
 * Host/Origin/Sec-Fetch-Site/JSON/launch-session checks, like every other /api route.
 */
export async function controlRoute(path: string, method: string, body: any, bridge: ToolCaller, approvals: () => unknown[]): Promise<RouteResult | undefined> {
  if (path === '/api/control' && method === 'GET') {
    if (!bridge.isConnected) return { status: 200, body: { status: controlStatus(undefined, false), permissions: [], approvals: approvals() } };
    try {
      const [status, permissions] = await Promise.all([bridge.callTool('get_status'), bridge.callTool('list_permissions')]);
      return { status: 200, body: { status: controlStatus(status, true), permissions: permissionItems(permissions), approvals: approvals() } };
    } catch (e) {
      return { status: 502, body: { error: (e as Error).message, code: (e as { code?: string }).code ?? 'TOOL_ERROR' } };
    }
  }
  if (method !== 'POST') return undefined;
  if (path === '/api/control/pause') {
    // Pausing only narrows what the agent can do: it applies at once and needs no approval.
    if (body?.paused !== true) return { status: 400, body: { error: 'paused must be true; resuming goes through /api/control/resume', code: 'INVALID_ARGUMENT' } };
    if (!bridge.isConnected) return { status: 503, body: NOT_CONNECTED };
    try {
      return { status: 200, body: await bridge.callTool('pause', { paused: true }) };
    } catch (e) {
      const f = writeFailure(e);
      return { status: f.status, body: f.body };
    }
  }
  if (path === '/api/control/resume') {
    // Releasing a pause needs the person: the daemon asks in its own dialog (relayed to this page) or
    // returns APPROVAL_REQUIRED with a passkey link. Same requestId to continue after approving.
    const requestId = body?.requestId;
    if (!isRequestId(requestId)) return { status: 400, body: MISSING_REQUEST_ID };
    if (!bridge.isConnected) return { status: 503, body: NOT_CONNECTED };
    try {
      return { status: 200, body: await bridge.callTool('pause', { paused: false, requestId }) };
    } catch (e) {
      const f = writeFailure(e, requestId);
      return { status: f.status, body: f.body };
    }
  }
  if (path === '/api/control/revoke') {
    const permissionId = body?.permissionId;
    if (!isPermissionId(permissionId)) return { status: 400, body: { error: 'permissionId from the permission list is required', code: 'INVALID_ARGUMENT' } };
    if (!bridge.isConnected) return { status: 503, body: NOT_CONNECTED };
    try {
      return { status: 200, body: await bridge.callTool('revoke_permission', { permissionId }) };
    } catch (e) {
      const f = writeFailure(e);
      return { status: f.status, body: f.body };
    }
  }
  return undefined;
}
