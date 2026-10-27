// ----------------------------------------------------------------------------
// Minimal, dependency-free MCP server over the stdio transport.
//
// The Model Context Protocol stdio transport is newline-delimited JSON-RPC 2.0:
// each message is a single UTF-8 line on stdin/stdout with no embedded newlines.
// We implement just enough of the spec for a tools-only server — `initialize`,
// `tools/list`, `tools/call`, `ping`, and the empty `resources`/`prompts` lists —
// so any MCP client (Claude Desktop, Claude Code, the Agent SDK, etc.) can drive
// the live KakaoTalk session. Logs MUST go to stderr; stdout is the wire.
//
// Dual-era (2026-07-28 "Versioning: Backward Compatibility"): a connection that opens with
// `initialize` is served with the negotiated legacy revision. Requests that carry
// `_meta["io.modelcontextprotocol/protocolVersion"]` are served statelessly per request:
// `server/discover`, `resultType`, cacheable list results, `UnsupportedProtocolVersionError`
// and Multi Round-Trip `input_required` results for human approval.
// ----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { KakaoError, longReplacer, toKakaoError, type McpToolGroup } from '@kakao-max/core';

export type { McpToolGroup };
import { validateArgs } from './validate-args.ts';
import { clientName, type ClientApprovalGate, type ClientContext, type ApprovalDetails } from './client-approval.ts';

/** The protocol revision we advertise; we echo the client's if it sends a known one. */
export const MCP_LIMITS = { requestBytes: 65536, frameBytes: 24 * 1024 * 1024, responseBytes: 1048576, concurrentTools: 16, pendingRequests: 32 } as const;

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
const META = { version: 'io.modelcontextprotocol/protocolVersion', capabilities: 'io.modelcontextprotocol/clientCapabilities',
  client: 'io.modelcontextprotocol/clientInfo', server: 'io.modelcontextprotocol/serverInfo' } as const;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
// The tool list only changes on restart; a short hint keeps clients from polling.
const LIST_CACHE = { ttlMs: 300_000, cacheScope: 'private' } as const;
/** Per-connection era: `initialize` pins legacy semantics for the rest of that connection. */
interface Connection { legacy: boolean; version?: string; client?: ClientContext;
  responses?: Map<string | number, (response: unknown) => void>;
  requestInput?: (params: Record<string, unknown>) => Promise<unknown>; }
/** Per-request modern context; undefined for legacy requests. */
interface Modern { version: string; client: ClientContext }

export interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContent {
  type: 'text';
  text: string;
}

/** MCP tool hints (2025-03-26+). Clients use them to decide what needs user confirmation. */
export interface ToolAnnotations {
  /** Does not change the account or local state the user cares about. */
  readOnlyHint?: boolean;
  /** May irreversibly remove or overwrite something (only meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** Talks to entities outside this server (other KakaoTalk users, Kakao servers). */
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** Transport byte cap for bounded media envelopes; omitted means the normal cap. */
  maxRequestBytes?: number;
  /** Advanced tools exist only when their group is enabled; a disabled tool is not callable either. */
  group?: McpToolGroup;
  /**
   * Handler. Return a value to be JSON-serialized as a single text content block,
   * or a pre-built content array. Throw to produce an `isError` tool result.
   */
  handler: (args: Record<string, any>, call?: ToolCallContext) => Promise<unknown> | unknown;
}

/** Per-call facts a handler may use; never taken from the agent's arguments. */
export interface ToolCallContext {
  /** On a retry after the client dialog, the operation the person just answered (from the verified dialog state). */
  approvalRequestId?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface McpServerInfo {
  name: string;
  version: string;
  /** Usage guidance returned in the initialize result (`instructions`). */
  instructions?: string;
  /** Enabled optional tool groups; default none. */
  toolGroups?: Iterable<McpToolGroup>;
}

export class McpStdioServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly info: McpServerInfo;
  private activeTools = 0;
  private activeLargeTools = 0;
  private clientApproval: ClientApprovalGate | undefined;
  private readonly groups: ReadonlySet<McpToolGroup>;

  constructor(info: McpServerInfo) {
    this.info = info;
    this.groups = new Set(info.toolGroups ?? []);
  }

  /** Enable human approval through the client's own dialog for modern clients that support elicitation. */
  setClientApproval(gate: ClientApprovalGate | undefined): void { this.clientApproval = gate; }

  registerTool(tool: ToolDefinition): void {
    if (tool.maxRequestBytes !== undefined && (!Number.isSafeInteger(tool.maxRequestBytes) || tool.maxRequestBytes < MCP_LIMITS.requestBytes || tool.maxRequestBytes > MCP_LIMITS.frameBytes)) throw new KakaoError('CONFIG_INVALID', 'Invalid tool request byte limit');
    if (tool.group && !this.groups.has(tool.group)) return;
    if (this.tools.has(tool.name)) throw new KakaoError('CONFIG_INVALID', `Duplicate MCP tool name: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  /** Start reading stdin and serving until the stream closes (classic stdio transport). */
  listen(): void {
    // stdin closed = client disconnected; let any in-flight async replies flush first.
    this.serveConnection(process.stdin, process.stdout, () => setTimeout(() => process.exit(0), 50));
    this.log(`${this.info.name} v${this.info.version} ready on stdio (${this.tools.size} tools)`);
  }

  /**
   * Serve one JSON-RPC connection over an arbitrary line-oriented duplex: `input` is read
   * line by line, replies are written to `output`. Used for stdio (process.stdin/stdout)
   * and for each socket connection in the always-on daemon. `onClose` fires when the input
   * ends (stdio exits the process; a socket just drops that connection). Each connection
   * gets its own writer, so concurrent socket clients never interleave onto one stream.
   */
  serveConnection(input: Readable, output: Writable, onClose?: () => void): void {
    let closed = false, inputEnded = false, notified = false, pending = 0;
    const connection: Connection = { legacy: false, responses: new Map() };
    const cancelDialogs = () => { for (const resolve of connection.responses!.values()) resolve({ action: 'cancel' }); connection.responses!.clear(); };
    let fragments: Buffer[] = [], size = 0;
    const finish = () => {
      if (inputEnded && pending === 0 && !notified) { notified = true; onClose?.(); }
    };
    const stop = () => {
      closed = true; fragments = []; size = 0; cancelDialogs();
      input.destroy();
    };
    const write = (obj: unknown): void => {
      if (closed || output.destroyed) return;
      let line = JSON.stringify(obj);
      if (Buffer.byteLength(line) > MCP_LIMITS.responseBytes) {
        const id = (obj as { id?: unknown }).id ?? null;
        line = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Response exceeds MCP byte limit; narrow the request' } });
      }
      if (output.writableLength + Buffer.byteLength(line) + 1 > MCP_LIMITS.responseBytes) {
        this.log('connection closed: MCP output backlog limit'); stop(); return;
      }
      try { output.write(line + '\n'); }
      catch { this.log('connection closed: MCP response write failed'); stop(); }
    };
    connection.requestInput = params => new Promise(resolve => {
      if (closed || inputEnded || connection.responses!.size >= 8) { resolve({ action: 'cancel' }); return; }
      const id = `approval:${randomUUID()}`;
      const timer = setTimeout(() => finish({ action: 'cancel' }), 120000);
      timer.unref();
      const finish = (response: unknown) => { clearTimeout(timer); connection.responses!.delete(id); resolve(response); };
      connection.responses!.set(id, finish);
      const { mode: _mode, ...legacyParams } = params;
      write({ jsonrpc: '2.0', id, method: 'elicitation/create', params: connection.version === '2025-11-25' ? params : legacyParams });
    });
    const line = (bytes: Buffer) => {
      const trimmed = bytes.toString('utf8').trim();
      if (!trimmed) return;
      let msg: unknown;
      try { msg = JSON.parse(trimmed); }
      catch {
        // Malformed input can contain message content or secrets. Never echo it.
        this.log('parse error: invalid MCP JSON');
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const name = (msg as { params?: { name?: unknown } } | null)?.params?.name;
      const toolLimit = typeof name === 'string' && (msg as { method?: unknown } | null)?.method === 'tools/call'
        ? this.tools.get(name)?.maxRequestBytes : undefined;
      if (bytes.length > (toolLimit ?? MCP_LIMITS.requestBytes)) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds MCP byte limit' } });
        stop(); return;
      }
      // Client replies must still reach a pending dialog when the ordinary request queue is full.
      const response = msg as { jsonrpc?: unknown; method?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
      if (response?.jsonrpc === '2.0' && response.method === undefined && validId(response.id) && ('result' in response || 'error' in response)) {
        void this.dispatch(write, msg, connection); return;
      }
      if (pending >= MCP_LIMITS.pendingRequests) {
        const id = (msg as Partial<JsonRpcRequest> | null)?.id;
        if (validId(id)) write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'MCP pending request limit reached' } });
        return;
      }
      pending++;
      void this.dispatch(write, msg, connection).catch(() => {
        this.log('MCP dispatch failed');
      }).finally(() => { pending--; finish(); });
    };
    input.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (!closed && start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        if (size + part.length > MCP_LIMITS.frameBytes) {
          write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds MCP byte limit' } });
          this.log('connection closed: MCP request byte limit'); stop(); return;
        }
        fragments.push(Buffer.from(part)); size += part.length;
        if (newline === -1) break;
        const request = Buffer.concat(fragments, size); fragments = []; size = 0;
        line(request); start = newline + 1;
      }
    });
    const end = () => {
      if (inputEnded) return;
      // As with readline, accept a bounded final line without a trailing newline.
      if (!closed && size) line(Buffer.concat(fragments, size));
      fragments = []; size = 0; inputEnded = true; cancelDialogs(); finish();
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', () => { this.log('MCP input stream failed'); stop(); });
    output.on('error', () => { this.log('MCP output stream failed'); stop(); });
  }

  private log(line: string): void {
    process.stderr.write(`[mcp] ${line}\n`);
  }

  private reply(write: (obj: unknown) => void, id: JsonRpcRequest['id'], result: unknown): void {
    if (id === undefined || id === null) return; // notification — no reply
    write({ jsonrpc: '2.0', id, result });
  }

  private error(write: (obj: unknown) => void, id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): void {
    if (id === undefined || id === null) return;
    write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }
  /** Modern results carry resultType and the server identity; legacy results are unchanged. */
  private result(modern: Modern | undefined, value: Record<string, unknown>): Record<string, unknown> {
    return modern ? { resultType: 'complete', ...value, _meta: { [META.server]: { name: this.info.name, version: this.info.version } } } : value;
  }

  /** Validate the JSON-RPC envelope, then route requests; client responses are ignored. */
  private async dispatch(write: (obj: unknown) => void, msg: unknown, connection: Connection = { legacy: false }): Promise<void> {
    if (Array.isArray(msg)) {
      // MCP 2025-06-18 removed JSON-RPC batching; we never supported it.
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batching is not supported' } });
      return;
    }
    const m = msg as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
    if (typeof m !== 'object' || m === null || m.jsonrpc !== '2.0') {
      write({ jsonrpc: '2.0', id: validId(m?.id) ? m.id : null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC 2.0 object' } });
      return;
    }
    if (m.method === undefined && ('result' in m || 'error' in m)) {
      if (validId(m.id)) connection.responses?.get(m.id)?.('error' in m ? { action: 'cancel' } : m.result);
      return;
    }
    if (typeof m.method !== 'string' || m.id === null || (m.id !== undefined && !validId(m.id))) {
      write({ jsonrpc: '2.0', id: validId(m.id) ? m.id : null, error: { code: -32600, message: 'Invalid Request: method must be a string and id a string or number' } });
      return;
    }
    return this.handle(write, m as JsonRpcRequest, connection);
  }

  private async handle(write: (obj: unknown) => void, msg: JsonRpcRequest, connection: Connection): Promise<void> {
    const { id, method, params } = msg;
    const meta = params?._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : undefined;
    let modern: Modern | undefined;
    if (!connection.legacy && method !== 'initialize' && meta?.[META.version] !== undefined) {
      const version = meta[META.version];
      if (typeof version !== 'string' || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        return this.error(write, id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version',
          { supported: [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS].reverse(), requested: version });
      }
      const caps = meta[META.capabilities] as Record<string, any> | undefined;
      const elicitation = caps?.elicitation;
      modern = { version, client: { name: clientName(meta[META.client]),
        // Form mode: an empty elicitation capability means form support (2025-11-25 and later).
        elicitation: !!elicitation && typeof elicitation === 'object' && (elicitation.form !== undefined || Object.keys(elicitation).length === 0) } };
    }
    try {
      switch (method) {
        case 'server/discover':
          return this.reply(write, id, { resultType: 'complete', supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
            capabilities: { tools: { listChanged: false } }, ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
            ...LIST_CACHE, _meta: { [META.server]: { name: this.info.name, version: this.info.version } } });
        case 'initialize': {
          if (connection.responses?.size) return this.error(write, id, -32600, 'Cannot reinitialize while approval is pending');
          connection.legacy = true;
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
          const elicitation = params?.capabilities?.elicitation;
          connection.version = protocolVersion;
          connection.client = { name: clientName(params?.clientInfo), elicitation: ['2025-06-18', '2025-11-25'].includes(protocolVersion) && !!elicitation && typeof elicitation === 'object' &&
            (Object.keys(elicitation).length === 0 || elicitation.form !== undefined) };
          this.log(`client initialized: protocol=${protocolVersion} elicitation=${connection.client.elicitation}`);
          return this.reply(write, id, {
            protocolVersion,
            serverInfo: { name: this.info.name, version: this.info.version },
            capabilities: { tools: { listChanged: false } },
            ...(this.info.instructions ? { instructions: this.info.instructions } : {})
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return; // notifications: nothing to reply
        case 'ping':
          // Removed in 2026-07-28; kept for legacy connections only.
          if (modern) return this.error(write, id, -32601, `method not found: ${method}`);
          return this.reply(write, id, {});
        case 'tools/list': {
          return this.reply(write, id, this.result(modern, {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {})
            })),
            ...(modern ? LIST_CACHE : {})
          }));
        }
        case 'resources/list':
          return this.reply(write, id, this.result(modern, { resources: [], ...(modern ? LIST_CACHE : {}) }));
        case 'prompts/list':
          return this.reply(write, id, this.result(modern, { prompts: [], ...(modern ? LIST_CACHE : {}) }));
        case 'tools/call':
          return await this.callTool(write, id, params, modern, connection);
        default:
          return this.error(write, id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      this.error(write, id, -32603, (e as Error).message);
    }
  }

  private async callTool(write: (obj: unknown) => void, id: JsonRpcRequest['id'], params: any, modern?: Modern, connection?: Connection, approvalAttempted = false, answeredRequestId?: string): Promise<void> {
    const name = params?.name;
    if (typeof name !== 'string') return this.error(write, id, -32602, 'Invalid params: "name" must be a string');
    const tool = this.tools.get(name);
    if (!tool) return this.error(write, id, -32602, `unknown tool: ${name}`);
    const args = (params?.arguments ?? {}) as Record<string, any>;
    let answer: string | undefined, approvalRequestId = answeredRequestId;
    try {
      const problems = validateArgs(tool.inputSchema, args);
      if (problems.length) throw new KakaoError('INVALID_ARGUMENT', `invalid arguments for ${name}: ${problems.join('; ')}`, { details: { problems } });
      // A Multi Round-Trip retry: verify the sealed state and record the person's answer before running the tool again.
      // A wrong or empty code records nothing; the tool then fails approval again and the dialog is shown again.
      if (modern && params?.requestState !== undefined) {
        if (!this.clientApproval) throw new KakaoError('APPROVAL_REQUIRED', 'Client confirmations are not enabled on this server');
        answer = this.clientApproval.answer(name, args, params.requestState, params.inputResponses, modern.client);
        approvalRequestId = this.clientApproval.requestIdOf(params.requestState);
        if (answer === 'declined') throw new KakaoError('POLICY_DENIED', DECLINED);
        if (answer === 'cancelled') throw new KakaoError('APPROVAL_REQUIRED', 'The approval dialog was dismissed; nothing was performed');
      }
      if (this.activeTools >= MCP_LIMITS.concurrentTools) throw new KakaoError('RATE_LIMITED', 'MCP tool concurrency limit reached; wait for active calls to finish');
      const large = (tool.maxRequestBytes ?? 0) > MCP_LIMITS.requestBytes;
      if (large && this.activeLargeTools >= 1) throw new KakaoError('RATE_LIMITED', 'A large MCP tool call is already active');
      this.activeTools++; if (large) this.activeLargeTools++;
      let out: unknown;
      try { out = await tool.handler(args, { approvalRequestId }); }
      finally { this.activeTools--; if (large) this.activeLargeTools--; }
      const content: ToolContent[] = Array.isArray(out)
        ? (out as ToolContent[])
        : // Raw LOCO responses can carry BSON Longs; write them as decimal strings, not {low, high, unsigned}.
        [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, longReplacer, 2) }];
      return this.reply(write, id, this.result(modern, { content, isError: false }));
    } catch (e) {
      // Per MCP, tool execution failures are returned as a result with isError,
      // not a protocol-level error, so the model can see and react to the message.
      // The code is in the text (for models that only read text) and in
      // structuredContent (for clients that branch on it).
      let err = toKakaoError(e);
      // Missing approval on a modern client that can show a form: ask the person instead of failing.
      const approval = !approvalAttempted && err.code === 'APPROVAL_REQUIRED' && (params?.requestState === undefined || answer === 'mismatch') ? err.details?.approval as ApprovalDetails | undefined : undefined;
      const client = modern?.client ?? connection?.client;
      const ask = approval && client && this.clientApproval?.request(name, args, approval, client);
      if (ask && modern) return this.reply(write, id, { ...ask, _meta: { [META.server]: { name: this.info.name, version: this.info.version } } });
      if (ask && !modern && client && connection?.requestInput) {
        try {
          const response = await connection.requestInput(ask.inputRequests.approve.params);
          const outcome = this.clientApproval!.answer(name, args, ask.requestState, { approve: response }, client);
          if (outcome === 'approved') return await this.callTool(write, id, params, undefined, connection, true, approval.requestId);
          throw new KakaoError(outcome === 'declined' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED',
            outcome === 'declined' ? DECLINED : 'The dialog was cancelled or the confirmation code did not match; nothing was performed');
        } catch (error) { err = toKakaoError(error); }
      }
      const hint = err.retryable ? ' (retryable)' : '';
      const recovery = err.toJSON().recovery;
      const next = recovery ? `\nNext step: ${recovery.message}` : '';
      return this.reply(write, id, this.result(modern, {
        content: [{ type: 'text', text: `Error [${err.code}]: ${err.message}${hint}${next}` }],
        structuredContent: { error: err.toJSON() },
        isError: true
      }));
    }
  }
}

// A client can answer "decline" without showing anything (some desktop apps do); the server cannot tell the two apart.
const DECLINED = 'The client dialog answered decline; this operation is now rejected. If the person saw no dialog, their MCP client may decline on its own: ' +
  'tell them, and do not retry with a new requestId to get around it (see the client compatibility list in the quick start)';

function validId(id: unknown): id is string | number {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}
