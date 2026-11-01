import { metadataChat, authorizedHistory } from './room-content.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBridge, type McpToolError } from './mcp-bridge.ts';
import { ApprovalRelay } from './approval-relay.ts';
import { isRequestId, writeFailure, MISSING_REQUEST_ID, NOT_CONNECTED } from './write-request.ts';
import { fetchOg, type OgPreview } from './og.ts';
// Only the program-location helper: the GUI never loads the account core.
import { packagedEntry } from '../../../packages/core/src/entry.ts';
import { localRequestProblem, createLaunchSecret, hasSession, matchesSecret, sessionCookie } from './http-security.ts';

// ----------------------------------------------------------------------------
// Local, single-account web GUI: a client of the running kakao-max daemon's MCP
// tools (loopback TCP, MCP_HOST/MCP_PORT), exposed to a browser over REST +
// Server-Sent Events. Binds to 127.0.0.1 only and never reads account settings
// or credentials; everything goes through the daemon's policy and approvals.
// ----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The package ships the page beside its bundle (dist/web-public); a checkout serves apps/web/public.
const WEB_DIR = path.resolve(__dirname, packagedEntry() ? 'web-public' : '../public');
const PORT = Number(process.env.PORT || 8899);
// Shown only on the person's terminal; see http-security.ts.
const LAUNCH_SECRET = createLaunchSecret();

const ogCache = new Map<string, { preview: OgPreview; at: number }>();
const OG_TTL_MS = 10 * 60 * 1000;

// Set from the daemon's get_status once the bridge connects.
let selfUserId = '';

// In-memory state the UI reads.
export interface ChatView {
  id: string;
  type: string;
  unreadCount: number;
  lastMessage: string;
  lastSendAt?: number;
  lastMessageType?: number;
  memberCount?: number;
  maxLogId: string | number;
  title?: string;
  isGroup?: boolean;
  avatar?: string;
  members?: Record<string, { name: string; img?: string }>;
}

const chats = new Map<string, ChatView>();
let connected = false;
let endpoint: { host: string; port: number } | undefined;

// SSE clients.
const sseClients = new Set<http.ServerResponse>();
function broadcast(event: string, data: unknown) {
  // A global SSE subscription is not authorization to read every room.
  if (event === 'message') return;
  if (event === 'chat-updated' && data && typeof data === 'object') data = metadataChat(data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// MCP client of the daemon (KAKAO_MCP_LISTEN, default 127.0.0.1:8787; a remote daemon via an SSH tunnel).
const mcpHost = process.env.MCP_HOST || '127.0.0.1';
const mcpPort = Number(process.env.MCP_PORT || 8787);
const bridge = new McpBridge({ host: mcpHost, port: mcpPort });

bridge.on('connected', async () => {
  console.log(`[bridge] connected to MCP session at ${mcpHost}:${mcpPort}`);
  await syncFromBridge();
});

bridge.on('disconnected', () => {
  console.warn('[bridge] disconnected from MCP session');
  connected = false;
  broadcast('status', { connected: false, chats: [...chats.values()].map(metadataChat) });
});

bridge.on('error', (err) => {
  console.warn('[bridge] error:', (err as Error).message);
});

// The daemon's confirmation dialogs for actions started here are shown on the GUI page.
const approvals = new ApprovalRelay({
  answer: (id, answer) => bridge.answerApproval(id, answer),
  hasViewers: () => sseClients.size > 0,
  notify: (event, data) => broadcast(event, data)
});
bridge.on('approval', (dialog) => approvals.request(dialog));
bridge.on('approval-closed', (id: string) => approvals.closed(id));

async function syncFromBridge(): Promise<void> {
  try {
    const status = await bridge.getStatus();
    connected = status.connected;
    if (status.userId) selfUserId = String(status.userId);
    endpoint = status.endpoint;

    const listRes = await bridge.listChats();
    const rawList = listRes.chats || [];
    if (rawList.length > 0) {
      chats.clear();
      for (const c of rawList) {
        chats.set(String(c.id), {
          id: String(c.id),
          type: c.type || 'DirectChat',
          unreadCount: c.unreadCount ?? 0,
          lastMessage: c.lastMessage || '',
          lastSendAt: c.lastSendAt || 0,
          maxLogId: c.maxLogId || '0',
          title: c.title,
          isGroup: c.isGroup
        });
      }
    }
    broadcast('status', { connected, endpoint, chats: [...chats.values()].map(metadataChat) });
    void resolveAllMeta();
  } catch (e) {
    console.warn('[bridge] syncFromBridge failed:', (e as Error).message);
  }
}

// Resolve real titles + member names/avatars in the background
let metaRunning = false;
async function resolveAllMeta() {
  if (metaRunning) return;
  metaRunning = true;
  for (const c of [...chats.values()]) {
    if (c.avatar && c.members) continue;
    try {
      const meta = await bridge.getChatInfo(c.id);
      if (meta) {
        if (meta.title) c.title = meta.title;
        if (meta.lastLogId) {
          try {
            if (BigInt(meta.lastLogId) > BigInt(c.maxLogId || '0')) c.maxLogId = meta.lastLogId;
          } catch {
            if (!c.maxLogId) c.maxLogId = meta.lastLogId;
          }
        }
        if (meta.members) {
          c.members = Object.fromEntries(meta.members.map((m) => [m.userId, { name: m.name, img: m.profileImageUrl }]));
          c.avatar =
            meta.members.find((m) => String(m.userId) !== String(selfUserId))?.profileImageUrl || meta.members[0]?.profileImageUrl;
          c.memberCount = meta.members.length || c.memberCount;
        }
        broadcast('chat-meta', {
          id: c.id,
          title: c.title,
          avatar: c.avatar,
          isGroup: c.isGroup,
          memberCount: c.memberCount
        });
      }
    } catch {
      /* skip unresolved */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  metaRunning = false;
}

// In-memory message store per chat (keeps live session messages & history)
const messageStore = new Map<string, any[]>();
const chatWatermarks = new Map<string, bigint>();

function computeUnreadCounts(chatId: string, messages: any[], isGroup?: boolean, memberCount?: number) {
  if (!messages || messages.length === 0) return messages;
  const selfId = String(selfUserId);
  const isDirect = !isGroup || (memberCount || 2) <= 2;

  if (isDirect) {
    let lastOtherLogId = BigInt(0);
    let lastOtherSendAt = 0;
    for (const m of messages) {
      if (String(m.authorId) !== selfId) {
        const idStr = String(m.messageId || m.logId || '0');
        try {
          const idBig = BigInt(idStr);
          if (idBig > lastOtherLogId) lastOtherLogId = idBig;
        } catch {}
        if ((m.sendAt || 0) > lastOtherSendAt) lastOtherSendAt = m.sendAt;
      }
    }
    const storedWatermark = chatWatermarks.get(String(chatId)) || BigInt(0);
    const effectiveWatermark = storedWatermark > lastOtherLogId ? storedWatermark : lastOtherLogId;

    for (const m of messages) {
      if (String(m.authorId) === selfId) {
        const idStr = String(m.messageId || m.logId || '0');
        let isUnread = false;
        try {
          const idBig = BigInt(idStr);
          if (effectiveWatermark > BigInt(0)) {
            isUnread = idBig > effectiveWatermark;
          } else {
            isUnread = (m.sendAt || 0) > lastOtherSendAt;
          }
        } catch {
          isUnread = (m.sendAt || 0) > lastOtherSendAt;
        }
        m.unreadCount = isUnread ? 1 : 0;
      } else {
        m.unreadCount = 0;
      }
    }
  } else {
    const defaultGroupUnread = Math.max(1, (memberCount || 2) - 1);
    for (const m of messages) {
      if (m.unreadCount === undefined && String(m.authorId) === selfId) {
        m.unreadCount = defaultGroupUnread;
      }
    }
  }
  return messages;
}

function recordMessage(chatId: string, m: any) {
  const cid = String(chatId);
  const list = messageStore.get(cid) || [];
  const id = m.messageId || m.logId;
  const idx = id ? list.findIndex((x) => String(x.messageId || x.logId) === String(id)) : -1;
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...m };
  } else {
    list.push(m);
  }
  list.sort((a, b) => (Number(a.sendAt) || 0) - (Number(b.sendAt) || 0));
  messageStore.set(cid, list);
}

// Inbound message stream from bridge
bridge.startInboundStream((m) => {
  if (m.type === -1 || m.raw?.isReadReceipt) {
    const wm = m.raw?.watermark || m.watermark;
    if (wm) {
      const cur = chatWatermarks.get(String(m.chatId)) || BigInt(0);
      try {
        const wBig = BigInt(String(wm));
        if (wBig > cur) chatWatermarks.set(String(m.chatId), wBig);
      } catch {}
      broadcast('read-state', { chatId: String(m.chatId), userId: m.authorId, watermark: String(wm) });
    }
    return;
  }
  console.log(`[bridge msg] chat=${m.chatId} from=${m.authorId} type=${m.type}`);
  const c = chats.get(String(m.chatId));
  const now = m.sendAt || Math.floor(Date.now() / 1000);
  if (c) {
    c.lastMessage = m.text ?? '';
    c.lastMessageType = m.type;
    c.lastSendAt = now;
    if (m.messageId) c.maxLogId = m.messageId;
    if (String(m.authorId) !== String(selfUserId)) {
      c.unreadCount = (c.unreadCount || 0) + 1;
      const msgId = m.messageId || m.logId;
      if (msgId) {
        try {
          const wBig = BigInt(String(msgId));
          const cur = chatWatermarks.get(String(m.chatId)) || BigInt(0);
          if (wBig > cur) chatWatermarks.set(String(m.chatId), wBig);
        } catch {}
      }
    }
  }
  recordMessage(String(m.chatId), { ...m, sendAt: now });
  broadcast('message', { ...m, sendAt: now });
  broadcast('chat-updated', {
    id: String(m.chatId),
    lastMessage: m.text ?? '',
    lastMessageType: m.type,
    lastSendAt: now,
    maxLogId: m.messageId || c?.maxLogId
  });
});

// ---- HTTP helpers ----
function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
}
/** A failed daemon write: a stable code, whether the outcome is unknown, and for APPROVAL_REQUIRED the passkey link. */
function sendToolError(res: http.ServerResponse, e: unknown, requestId?: string) {
  const { status, body } = writeFailure(e, requestId);
  return sendJson(res, status, body);
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(res: http.ServerResponse, file: string) {
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  const port = (server.address() as AddressInfo).port;
  const problem = localRequestProblem(req, port);
  if (problem) return sendJson(res, 403, { error: `Refused: only this GUI's own page may use the API (${problem})` });
  if (p === '/launch' && req.method === 'GET') {
    if (!matchesSecret(url.searchParams.get('t'), LAUNCH_SECRET)) return sendJson(res, 403, { error: 'Invalid launch link; use the one printed in the terminal that started the GUI' });
    res.writeHead(303, { 'Set-Cookie': sessionCookie(port, LAUNCH_SECRET), Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }
  if (!hasSession(req.headers, port, LAUNCH_SECRET)) {
    if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'Open the launch link printed in the terminal that started the GUI' });
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('kakao-max web: open the launch link printed in the terminal that started the GUI.\n');
  }
  try {
    if (p === '/api/approvals' && req.method === 'GET') {
      return sendJson(res, 200, { approvals: approvals.list() });
    }
    if (p === '/api/approvals/answer' && req.method === 'POST') {
      const problem = approvals.answerFromPage(await readBody(req));
      return problem ? sendJson(res, 409, { error: problem }) : sendJson(res, 200, { ok: true });
    }
    if (p === '/api/state') {
      return sendJson(res, 200, { userId: selfUserId, connected, endpoint, chats: [...chats.values()].map(metadataChat) });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ connected, endpoint, chats: [...chats.values()].map(metadataChat) })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/send' && req.method === 'POST') {
      const { chatId, text, reply, mentions, requestId } = await readBody(req);
      if (!chatId || !text) return sendJson(res, 400, { error: 'chatId and text required' });
      if (!isRequestId(requestId)) return sendJson(res, 400, MISSING_REQUEST_ID);
      // Never show an unsent message as sent: a refused or failed send returns its error instead of a placeholder id.
      if (!bridge.isConnected) return sendJson(res, 503, NOT_CONNECTED);
      let w: any;
      try {
        const replyArg =
          reply && reply.logId && reply.userId
            ? { logId: String(reply.logId), userId: String(reply.userId), text: reply.text ? String(reply.text) : undefined }
            : undefined;
        const mentionsArg =
          Array.isArray(mentions) && mentions.length
            ? mentions.map((m: any) => ({ userId: String(m.userId), at: m.at, len: Number(m.len) }))
            : undefined;
        w = await bridge.sendMessage(requestId, String(chatId), String(text), { reply: replyArg, mentions: mentionsArg });
      } catch (e) {
        console.warn(`[server] send failed via bridge: ${(e as Error).message}`);
        return sendToolError(res, e, requestId);
      }
      const c = chats.get(String(chatId));
      const isDirect = !c?.isGroup || (c?.memberCount || 2) <= 2;
      const initialUnread = isDirect ? 1 : Math.max(1, (c?.memberCount || 2) - 1);
      const now = Math.floor(Date.now() / 1000);
      if (c) {
        c.lastMessage = String(text);
        c.lastMessageType = 1;
        c.lastSendAt = now;
        if (w.logId) {
          c.maxLogId = w.logId;
          recordMessage(String(chatId), {
            chatId: String(chatId),
            authorId: String(selfUserId),
            authorName: '나',
            text: String(text),
            type: 1,
            sendAt: now,
            messageId: String(w.logId),
            logId: String(w.logId),
            unreadCount: initialUnread
          });
        }
      }
      broadcast('chat-updated', {
        id: String(chatId),
        lastMessage: String(text),
        lastMessageType: 1,
        lastSendAt: now,
        maxLogId: w.logId
      });
      return sendJson(res, 200, { ...w, sendAt: now, unreadCount: initialUnread });
    }
    if (p === '/api/read' && req.method === 'POST') {
      const { chatId, watermark, confirm, requestId } = await readBody(req);
      if (confirm !== true) return sendJson(res, 403, { error: 'Read receipts require separate explicit approval (confirm=true)' });
      if (!chatId || !watermark) return sendJson(res, 400, { error: 'chatId and watermark required' });
      if (!isRequestId(requestId)) return sendJson(res, 400, MISSING_REQUEST_ID);
      if (bridge.isConnected) {
        try {
          await bridge.markRead(requestId, String(chatId), String(watermark));
        } catch (e) {
          return sendToolError(res, e, requestId);
        }
      } else return sendJson(res, 503, NOT_CONNECTED);
      const c = chats.get(String(chatId));
      if (c) {
        c.unreadCount = 0;
      }
      try {
        const wBig = BigInt(String(watermark));
        const cur = chatWatermarks.get(String(chatId)) || BigInt(0);
        if (wBig > cur) chatWatermarks.set(String(chatId), wBig);
      } catch {}
      broadcast('read-state', { chatId: String(chatId), watermark: String(watermark) });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const { chatId, logId, requestId } = await readBody(req);
      if (!chatId || !logId) return sendJson(res, 400, { error: 'chatId and logId required' });
      if (!isRequestId(requestId)) return sendJson(res, 400, MISSING_REQUEST_ID);
      if (!bridge.isConnected) return sendJson(res, 503, NOT_CONNECTED);
      try {
        const r = await bridge.deleteMessage(requestId, String(chatId), String(logId));
        if (r.status === 0) broadcast('message-deleted', { chatId: String(chatId), logId: String(logId) });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendToolError(res, e, requestId);
      }
    }
    if (p === '/api/forward' && req.method === 'POST') {
      const { chatId, text, type, extra, requestId } = await readBody(req);
      if (!chatId || !text) return sendJson(res, 400, { error: 'chatId and text required' });
      if (!isRequestId(requestId)) return sendJson(res, 400, MISSING_REQUEST_ID);
      if (!bridge.isConnected) return sendJson(res, 503, NOT_CONNECTED);
      try {
        const r = await bridge.forwardMessage(requestId, String(chatId), { text: String(text), type: type ? Number(type) : 1, extra: extra ? String(extra) : undefined });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendToolError(res, e, requestId);
      }
    }
    if (p === '/api/self-delete' && req.method === 'POST') {
      const { chatId, logIds } = await readBody(req);
      if (!chatId || !Array.isArray(logIds) || logIds.length === 0) return sendJson(res, 400, { error: 'chatId and logIds[] required' });
      if (!bridge.isConnected) return sendJson(res, 503, { error: 'not connected' });
      try {
        const r = await bridge.selfDeleteMessages(String(chatId), logIds.map((l: any) => String(l)));
        // Local-only hide: no status code; remove exactly the ids now hidden in the daemon's store.
        for (const l of [...r.hidden, ...r.alreadyHidden]) broadcast('message-deleted', { chatId: String(chatId), logId: String(l) });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }
    if (p === '/api/leave' && req.method === 'POST') {
      const { chatId, silence, block, requestId } = await readBody(req);
      if (!chatId) return sendJson(res, 400, { error: 'chatId required' });
      if (!isRequestId(requestId)) return sendJson(res, 400, MISSING_REQUEST_ID);
      if (!bridge.isConnected) return sendJson(res, 503, NOT_CONNECTED);
      try {
        const r = await bridge.leaveChat(requestId, String(chatId), { silence: silence === true, block: block === true });
        if (r.status === 0) {
          chats.delete(String(chatId));
          broadcast('chat-left', { chatId: String(chatId) });
        }
        return sendJson(res, 200, r);
      } catch (e) {
        return sendToolError(res, e, requestId);
      }
    }
    if (p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const chatId = url.searchParams.get('chatId');
      const limit = Number(url.searchParams.get('limit')) || 20;
      if (!q) return sendJson(res, 200, { count: 0, messages: [] });
      if (!chatId) return sendJson(res, 400, { error: 'chatId required: kakao-max searches one room at a time' });
      if (bridge.isConnected) {
        try {
          const r = await bridge.searchMessages(q, { chatId, limit });
          return sendJson(res, 200, r);
        } catch (e) {
          return sendJson(res, 502, { error: (e as Error).message });
        }
      }
      return sendJson(res, 503, { error: 'bridge not connected' });
    }
    if (p === '/api/unread-summary') {
      if (bridge.isConnected) {
        try {
          const r = await bridge.getUnreadSummary();
          return sendJson(res, 200, r);
        } catch (e) {
          return sendJson(res, 502, { error: (e as Error).message });
        }
      }
      return sendJson(res, 503, { error: 'bridge not connected' });
    }
    if (p === '/api/friends') {
      const q = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit')) || 100;
      if (bridge.isConnected) {
        try {
          const r = await bridge.listFriends(q, limit);
          return sendJson(res, 200, r);
        } catch (e) {
          return sendJson(res, 502, { error: (e as Error).message });
        }
      }
      return sendJson(res, 503, { error: 'bridge not connected' });
    }
    if (p === '/api/friends/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const query = body.userId || body.query;
      if (!query) return sendJson(res, 400, { error: 'userId or query required' });
      if (!bridge.isConnected) return sendJson(res, 503, { error: 'bridge not connected' });
      try {
        const r = await bridge.openDirectChat(String(query));
        if (r.ok && r.chatId) {
          if (!chats.has(r.chatId)) {
            chats.set(r.chatId, {
              id: r.chatId,
              type: 'DirectChat',
              title: r.title,
              isGroup: false,
              memberCount: 2,
              unreadCount: 0,
              lastMessage: '',
              maxLogId: '0'
            });
            broadcast('chat-created', chats.get(r.chatId));
          }
        }
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
    }
    if (p === '/api/friends/sync' && req.method === 'POST') {
      if (!bridge.isConnected) return sendJson(res, 503, { error: 'bridge not connected' });
      try {
        const r = await bridge.syncFriends();
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
    }
    if (p === '/api/history') {
      const chatId = url.searchParams.get('chatId');
      if (!chatId) return sendJson(res, 400, { error: 'chatId required' });
      const chat = chats.get(chatId);
      // Ensure member names + real max logId are available
      if (chat && (!chat.members || !chat.avatar) && bridge.isConnected) {
        try {
          const meta = await bridge.getChatInfo(chatId);
          if (meta) {
            if (meta.title) chat.title = meta.title;
            if (meta.lastLogId) {
              try {
                if (BigInt(meta.lastLogId) > BigInt(chat.maxLogId || '0')) chat.maxLogId = meta.lastLogId;
              } catch {
                if (!chat.maxLogId) chat.maxLogId = meta.lastLogId;
              }
            }
            if (meta.members) {
              chat.members = Object.fromEntries(meta.members.map((m) => [m.userId, { name: m.name, img: m.profileImageUrl }]));
              chat.avatar =
                meta.members.find((m) => String(m.userId) !== String(selfUserId))?.profileImageUrl || meta.members[0]?.profileImageUrl;
            }
          }
        } catch {
          /* ignore */
        }
      }
      const maxParam = url.searchParams.get('max');
      const limit = Number(url.searchParams.get('limit')) || 50;
      try {
        const fetched = await authorizedHistory(bridge.isConnected,
          () => bridge.getHistory(chatId, limit, maxParam ? String(maxParam) : undefined));
        // Never merge old cached contents into a newly authorized bounded batch.
        computeUnreadCounts(chatId, fetched, chat?.isGroup, chat?.memberCount || 2);
        return sendJson(res, 200, {
          title: chat?.title, members: chat?.members ?? {}, messages: fetched,
          fetchedCount: fetched.length, hasMore: fetched.length > 0
        });
      } catch (e) {
        const err = e as McpToolError;
        return sendJson(res, 403, { error: 'History is unavailable under the current room access policy or connection state', code: err.code, approvalUrl: err.approvalUrl });
      }
    }
    if (p === '/api/media') {
      const chatId = url.searchParams.get('chatId');
      const token = url.searchParams.get('token');
      const messageId = url.searchParams.get('messageId');
      const isMini = url.searchParams.get('mini') === '1' || url.searchParams.get('mini') === 'true';
      if (!chatId || !token || !messageId) return sendJson(res, 400, { error: 'chatId, messageId and token required' });
      if (!bridge.isConnected) return sendJson(res, 503, { error: 'bridge not connected' });
      try {
        const r = await bridge.downloadAttachment(String(chatId), { token: String(token), messageId: String(messageId), isMini });
        if (r && r.dataBase64) {
          const buf = Buffer.from(r.dataBase64, 'base64');
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store'
          });
          return res.end(buf);
        }
        return sendJson(res, 404, { error: 'media not found' });
      } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
    }
    if (p === '/api/og') {
      const target = url.searchParams.get('url');
      if (!target) return sendJson(res, 400, { error: 'url required' });
      const cached = ogCache.get(target);
      if (cached && Date.now() - cached.at < OG_TTL_MS) return sendJson(res, 200, cached.preview);
      try {
        const preview = await fetchOg(target);
        ogCache.set(target, { preview, at: Date.now() });
        if (ogCache.size > 500) ogCache.delete(ogCache.keys().next().value as string);
        return sendJson(res, 200, preview);
      } catch (e) {
        return sendJson(res, 200, { url: target, error: (e as Error).message });
      }
    }
    // static
    return serveStatic(res, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  } catch (e) {
    return sendJson(res, 500, { error: (e as Error).message });
  }
});

async function main() {
  server.listen(PORT, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    // Only this terminal sees the secret; anyone who has the link can use the GUI as you.
    console.log(`[server] web UI ready. Open this link (do not share it): http://127.0.0.1:${port}/launch?t=${LAUNCH_SECRET}`);
  });

  console.log(`[server] connecting to MCP session at ${mcpHost}:${mcpPort}...`);
  try {
    await bridge.connect();
    console.log('[server] MCP bridge connected.');
  } catch (e) {
    console.warn('[server] MCP bridge connect error:', (e as Error).message);
    broadcast('status', { connected: false, error: (e as Error).message, chats: [...chats.values()].map(metadataChat) });
  }
}
main().catch((e) => {
  console.error('[server] fatal:', e);
  process.exit(1);
});
