// Loopback-only HTTP listener for the passkey approval page. It is separate from the MCP socket:
// nothing here is reachable through an MCP tool, and every approval needs a WebAuthn assertion
// with user verification, so neither a token holder nor browser automation can approve.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { KakaoError, approvalChallenge, rpIdForOrigin, verifyWebAuthnRegistration, type ApproverRegistry } from '@kakao-max/core';
import type { ApprovalCenter } from './approval-center.ts';
import { approvalLabel } from './client-approval.ts';
import { checkEnrollment, clearEnrollment } from './enrollment.ts';
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from './approval-page.ts';

const BODY_LIMIT = 64 * 1024;
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin'
};
const STATUS: Record<string, number> = { NOT_FOUND: 404, APPROVAL_REQUIRED: 403, POLICY_DENIED: 403, OPERATION_EXPIRED: 410, INVALID_ARGUMENT: 400, IDEMPOTENCY_CONFLICT: 409 };

export interface ApprovalServerOptions {
  center: ApprovalCenter; registry: ApproverRegistry; origin: string; dataDir: string;
  /** host:port the listener binds; accepted as Host for direct loopback use. */
  listen: string; log?: (line: string) => void; now?: () => number;
}

export function createApprovalServer(opts: ApprovalServerOptions): http.Server {
  const origin = new URL(opts.origin), rpId = rpIdForOrigin(opts.origin), hosts = new Set([origin.host, opts.listen]);
  const now = () => (opts.now ?? Date.now)();
  let enrollChallenge: { challenge: Buffer; expiresAt: number } | undefined;
  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
  const body = (req: http.IncomingMessage) => new Promise<Record<string, any>>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > BODY_LIMIT) { reject(new KakaoError('INVALID_ARGUMENT', 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object'); resolve(v); } catch { reject(new KakaoError('INVALID_ARGUMENT', 'JSON object body required')); } });
    req.on('error', reject);
  });
  const token = (req: http.IncomingMessage) => { const t = req.headers['x-approval-token']; return typeof t === 'string' ? t : undefined; };

  return http.createServer(async (req, res) => {
    try {
      // DNS rebinding and cross-site requests: exact Host, and exact Origin on every state change.
      if (!hosts.has(String(req.headers.host ?? ''))) return json(res, 421, { error: 'MISDIRECTED' });
      if (req.method === 'POST' && (req.headers.origin !== opts.origin || !String(req.headers['content-type'] ?? '').startsWith('application/json'))) return json(res, 403, { error: 'ORIGIN_REQUIRED' });
      const url = new URL(req.url ?? '/', opts.origin), p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/enroll' || /^\/a\/[0-9a-f-]{36}$/.test(p))) return send(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/app.js') return send(res, 200, PAGE_JS, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && p === '/app.css') return send(res, 200, PAGE_CSS, 'text/css; charset=utf-8');

      const a = /^\/api\/approvals\/([0-9a-f-]{36})(\/approve|\/reject|\/media\/(\d{1,2}))?$/.exec(p);
      if (a) {
        const [, requestId, sub, index] = a;
        if (req.method === 'GET' && !sub) {
          const pending = opts.center.get(requestId, token(req));
          const envelope = JSON.parse(pending.signingText);
          return json(res, 200, { requestId, code: pending.code, expiresAt: pending.expiresAt, envelope, label: approvalLabel(envelope.action),
            challenge: approvalChallenge(pending.signingText).toString('base64url'), rpId,
            allowCredentials: opts.registry.list().filter(x => x.rpId === rpId).map(x => x.id), media: pending.media.length, rememberable: !!opts.center.rememberable(pending) });
        }
        if (req.method === 'GET' && index !== undefined) {
          const m = opts.center.get(requestId, token(req)).media[Number(index)];
          if (!m) throw new KakaoError('NOT_FOUND', 'No such preview');
          return send(res, 200, m.bytes, m.type);
        }
        if (req.method === 'POST' && sub === '/approve') {
          const b = await body(req);
          opts.center.approve(requestId, token(req), { credentialId: b.credentialId, clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData, signature: b.signature }, b.remember === true);
          opts.log?.(`[approval] approved ${requestId}`);
          return json(res, 200, { state: 'approved' });
        }
        if (req.method === 'POST' && sub === '/reject') {
          opts.center.reject(requestId, token(req));
          opts.log?.(`[approval] rejected ${requestId}`);
          return json(res, 200, { state: 'rejected' });
        }
      }
      if (req.method === 'POST' && p === '/api/enroll/options') {
        const b = await body(req);
        if (!checkEnrollment(opts.dataDir, b.code, now())) throw new KakaoError('APPROVAL_REQUIRED', 'Invalid or expired enrollment code');
        enrollChallenge = { challenge: randomBytes(32), expiresAt: now() + 5 * 60_000 };
        return json(res, 200, { challenge: enrollChallenge.challenge.toString('base64url'), rpId, userId: randomBytes(16).toString('base64url'),
          userName: 'kakao-mcp-operator', excludeCredentials: opts.registry.list().map(x => x.id) });
      }
      if (req.method === 'POST' && p === '/api/enroll') {
        const b = await body(req), pending = enrollChallenge;
        if (!pending || pending.expiresAt <= now() || !checkEnrollment(opts.dataDir, b.code, now())) throw new KakaoError('APPROVAL_REQUIRED', 'Invalid or expired enrollment');
        const approver = verifyWebAuthnRegistration({ credentialId: b.credentialId, publicKey: b.publicKey, alg: b.alg, clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData },
          pending.challenge, opts.origin, b.label, now());
        opts.registry.add(approver);
        enrollChallenge = undefined; clearEnrollment(opts.dataDir); // single use
        opts.log?.('[approval] enrolled passkey');
        return json(res, 200, { id: approver.id, label: approver.label });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = error instanceof KakaoError ? error.code : 'INTERNAL';
      if (code === 'INTERNAL') opts.log?.('[approval] internal request failure');
      return json(res, STATUS[code] ?? 500, { error: code });
    }
  });
}
