// Keep the client's stdio alive across a daemon restart. Only MCP initialization
// is repeated; tool requests, approval answers, and notifications are never replayed.
import type { Duplex, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

interface Request { id?: string | number; method?: string; params?: Record<string, unknown>; [key: string]: unknown }
const MAX_FRAME = 32 * 1024 * 1024;
export function reconnectingBridge(input: Readable, output: Writable, dial: () => Promise<Duplex>, opts: { delayMs?: number; handshakeMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let stream: Duplex | undefined, done = false, ended = false, ready = false, connectedOnce = false;
    let timer: ReturnType<typeof setTimeout> | undefined, handshake: ReturnType<typeof setTimeout> | undefined;
    let initializeCompleted = false, failures = 0;
    let initialize: Request | undefined, reinitId: string | undefined;
    const pending = new Map<string | number, Request>(), serverRequests = new Set<string | number>();
    const clientDecoder = new StringDecoder('utf8'); let clientBuffer = '';
    const write = (packet: unknown) => {
      if (!done && !output.write(JSON.stringify(packet) + '\n')) {
        const current = stream; current?.pause();
        output.once('drain', () => { if (stream === current) current?.resume(); });
      }
    };
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(handshake);
      input.removeListener('data', fromClient); input.removeListener('end', onEnd); input.removeListener('error', fail); output.removeListener('error', fail);
      stream?.destroy(); if (error) reject(error); else resolve();
    };
    const interrupted = (r: Request, sent: boolean) => {
      if (r.id === undefined) return;
      if (r.method === 'tools/call') {
        const hasOperation = typeof (r.params?.arguments as Record<string, unknown> | undefined)?.requestId === 'string';
        const error = { code: 'NOT_CONNECTED', retryable: false, message: sent && hasOperation ?
          'Daemon connection interrupted. This operation may have run; inspect its existing requestId with get_operation before continuing. Never create a replacement requestId or replay an approval answer.' :
          sent ? 'Daemon connection interrupted. Wait for reconnection, then retry metadata reads. Review any uncertain account-changing operation before repeating it.' :
          'Daemon is reconnecting. This request was not sent. Wait, then retry using the same requestId if applicable.',
          recovery: { action: sent && hasOperation ? 'inspect_existing_operation' : 'wait_for_connection', automaticReplay: false } };
        const modern = !initialize && (r.params?._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
        write({ jsonrpc: '2.0', id: r.id, result: { ...(modern ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kakao-max-connector', version: '1' } } } : {}), isError: true, structuredContent: { error }, content: [{ type: 'text', text: error.message }] } });
      } else write({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'Daemon reconnecting; request was not replayed' } });
    };
    const disconnected = (current: Duplex) => {
      if (stream !== current || done) return;
      stream = undefined; ready = false; reinitId = undefined; clearTimeout(handshake);
      for (const r of pending.values()) if (r.method !== 'initialize') interrupted(r, true);
      pending.clear(); serverRequests.clear(); current.destroy(); input.resume();
      if (ended) return finish();
      timer = setTimeout(() => { void connect(); }, Math.min((opts.delayMs ?? 1000) * 2 ** Math.min(failures++, 4), 15000));
    };
    const connect = async () => {
      if (done || ended) return;
      let current: Duplex;
      try { current = await dial(); }
      catch { if (!done && !ended) timer = setTimeout(() => { void connect(); }, Math.min((opts.delayMs ?? 1000) * 2 ** Math.min(failures++, 4), 15000)); return; }
      if (done || ended) { current.destroy(); return; }
      stream = current; ready = !connectedOnce || !initialize;
      const decoder = new StringDecoder('utf8'); let buffer = '';
      current.on('error', () => disconnected(current)); current.on('close', () => disconnected(current)); current.on('end', () => disconnected(current));
      current.on('data', chunk => {
        if (stream !== current || done) return;
        buffer += decoder.write(Buffer.from(chunk));
        if (Buffer.byteLength(buffer) > MAX_FRAME) return finish(new Error('MCP frame exceeds connector limit'));
        let n: number;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
          if (!line.trim()) continue;
          let packet: Request;
          try { packet = JSON.parse(line); } catch { return finish(new Error('Invalid daemon MCP frame')); }
          failures = 0;
          // The upstream daemon has a fixed list per process, but this logical
          // connection spans replacements. Advertise the proxy's list-change
          // notification so clients refresh schemas after reconnecting.
          if (packet.id === reinitId || packet.id !== undefined && pending.get(packet.id)?.method === 'initialize') {
            const result = packet.result as { capabilities?: { tools?: { listChanged?: boolean } } } | undefined;
            if (result?.capabilities?.tools) result.capabilities.tools.listChanged = true;
          }
          if (reinitId && packet.id === reinitId) {
            clearTimeout(handshake); reinitId = undefined;
            if (packet.error) { disconnected(current); return; }
            if (initializeCompleted) current.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            else { write({ ...packet, id: initialize?.id }); initializeCompleted = true; }
            ready = true;
            // Clients can refresh schemas after a code update. No user operation is retried.
            write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); continue;
          }
          if (packet.method && packet.id !== undefined) serverRequests.add(packet.id);
          else if (packet.id !== undefined) {
            if (pending.get(packet.id)?.method === 'initialize' && !packet.error) initializeCompleted = true;
            pending.delete(packet.id);
          }
          write(packet);
        }
      });
      if (connectedOnce && initialize) {
        reinitId = `connector-${randomUUID()}`;
        current.write(JSON.stringify({ ...initialize, id: reinitId }) + '\n');
        handshake = setTimeout(() => disconnected(current), opts.handshakeMs ?? 5000);
      }
      connectedOnce = true;
      // At startup, requests have not been sent and may safely be buffered until
      // the first transport opens. After any disconnect no operation is buffered.
      if (clientBuffer.includes('\n')) drainClient();
    };
    const handle = (packet: Request) => {
      if (packet.method === 'initialize') initialize = packet;
      if (!ready || !stream) { interrupted(packet, false); return; }
      if (!packet.method && packet.id !== undefined) {
        if (!serverRequests.delete(packet.id)) return; // Stale dialog answers cannot cross connections.
      } else if (packet.id !== undefined) pending.set(packet.id, packet);
      const current = stream;
      if (!current.write(JSON.stringify(packet) + '\n')) {
        input.pause(); current.once('drain', () => { if (stream === current) input.resume(); });
      }
    };
    const drainClient = () => {
      let n: number;
      while ((n = clientBuffer.indexOf('\n')) >= 0) {
        const line = clientBuffer.slice(0, n); clientBuffer = clientBuffer.slice(n + 1);
        if (!line.trim()) continue;
        try { handle(JSON.parse(line)); } catch { finish(new Error('Invalid client MCP frame')); return; }
      }
    };
    function fromClient(chunk: Buffer | string) {
      clientBuffer += clientDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.byteLength(clientBuffer) > MAX_FRAME) return finish(new Error('MCP frame exceeds connector limit'));
      // Buffer only before the first connection. Reconnection never queues requests.
      if (connectedOnce) drainClient();
    }
    function onEnd() { ended = true; clearTimeout(timer); if (stream && ready) stream.end(); else finish(); }
    function fail() { finish(new Error('MCP client stream closed')); }
    input.on('data', fromClient); input.once('end', onEnd); input.once('error', fail); output.once('error', fail);
    void connect();
  });
}
