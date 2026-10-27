// ----------------------------------------------------------------------------
// Outbound-messaging policy layer: resource limits, never human approval.
//
// The MCP server exposes a live KakaoTalk account. Human approval is proven only by the
// journaled operation services (client confirmation dialog, passkey page, or a room
// permission the person granted). This module bounds what any approved operation may do:
//
//   • pause switch — blocks ALL sends and account changes while engaged
//   • room ceiling — optional operator list of rooms agents may ever reach
//                    (KAKAO_ROOM_CEILING; empty = no ceiling). Never approval.
//   • rate limit   — sliding window per room and across all rooms
//   • audit log    — every attempt, allowed or denied, as metadata only (text length,
//                    never the text), matching this repo's rule against logging chat content.
//
// The notification destination (KAKAO_NOTIFY_CHAT_ID) receives the daemon's own
// content-free approval notices. Agent sends there need a room permission like any room.
//
// Config comes from env / .env.local (same resolution as credentials.ts):
//   KAKAO_NOTIFY_CHAT_ID    daemon notice destination
//   KAKAO_ROOM_CEILING      comma/space-separated operator ceiling of reachable rooms
//   KAKAO_PAUSED            truthy ('1'/'true'/'yes'/'on') → start paused
//   KAKAO_AUDIT_LOG         audit log path (default: <.env.local dir>/kakao-mcp-audit.log)
//   KAKAO_RATE_WINDOW_SEC   sliding window for the send rate limit (default 60)
//   KAKAO_RATE_PER_CHAT     max allowed sends per chat per window (default 5; 0 = off)
//   KAKAO_RATE_GLOBAL       max allowed sends across all chats per window (default 15; 0 = off)
//
// The rate limit bounds the blast radius of a misbehaving / prompt-injected agent
// and keeps sending at a human pace.
//
// Zero runtime deps; runs under `node --experimental-strip-types` (no TS
// parameter properties / enums).
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { KakaoError } from './errors.ts';

export type SendCategory = 'notification' | 'message-as-you';

export interface PolicyDecision {
  allowed: boolean;
  category: SendCategory;
  /** A human-readable explanation, surfaced to the MCP client on a denial. */
  reason: string;
}

export interface AuditEntry {
  ts: string;
  chatId: string;
  category: SendCategory;
  decision: 'allowed' | 'denied';
  reason: string;
  textLength: number;
}

export interface PolicyConfig {
  /** Destination of the daemon's own content-free notices, if any. */
  notifyChatId?: string;
  /** Operator ceiling of rooms agents may ever reach; empty = no ceiling. Never approval. */
  ceiling: string[];
  /** Absolute path of the append-only JSONL audit log. */
  auditLogPath: string;
  /** Whether the pause switch starts engaged (from KAKAO_PAUSED). */
  pausedAtStart: boolean;
  /** Sliding-window send rate limit; omitted = defaults. A limit of 0 disables it. */
  rateLimit?: RateLimitConfig;
}

export interface RateLimitConfig {
  windowMs: number;
  perChat: number;
  global: number;
}

const ROOM_ID = /^[1-9]\d{0,18}$/;
const MAX_ID = 9223372036854775807n;

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { windowMs: 60_000, perChat: 5, global: 15 };

/** Resolve all settings through the account configuration boundary. */
export function loadPolicyConfig(opts: { envPath?: string; env?: Record<string, string | undefined> } = {}): PolicyConfig {
  return loadConfig(opts).policy;
}

/**
 * The runtime limits for outbound operations. `decide()` is a pure function of the current
 * config, pause state and rate window; `authorize()` adds the rate slot and audit entry, and
 * is called only after the journaled service verified human approval.
 */
export class SendPolicy {
  private readonly notifyChatId?: string;
  private readonly ceiling: Set<string>;
  private readonly auditLogPath: string;
  private paused: boolean;
  private readonly rate: RateLimitConfig;
  private readonly now: () => number;
  // Run-scoped correlation only: no raw account/room IDs or persistent tracking key in diagnostics.
  private readonly auditKey = randomBytes(32);
  /** Timestamps (ms) of allowed sends inside the current window, oldest first. */
  private sends: Array<{ at: number; chatId: string }> = [];

  constructor(config: PolicyConfig, opts: { now?: () => number } = {}) {
    this.notifyChatId = config.notifyChatId;
    this.ceiling = new Set(config.ceiling);
    this.auditLogPath = config.auditLogPath;
    this.paused = config.pausedAtStart;
    this.rate = config.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.now = opts.now ?? Date.now;
  }

  /** Allowed sends inside the window ending now (globally and for `chatId`). */
  private recentSends(chatId: string): { global: number; chat: number; oldestChat?: number; oldestGlobal?: number } {
    const cutoff = this.now() - this.rate.windowMs;
    const inWindow = this.sends.filter((s) => s.at > cutoff);
    const forChat = inWindow.filter((s) => s.chatId === chatId);
    return { global: inWindow.length, chat: forChat.length, oldestChat: forChat[0]?.at, oldestGlobal: inWindow[0]?.at };
  }

  /** A rate-limit denial reason, or undefined when the send fits in the window. */
  private rateLimitReason(chatId: string): string | undefined {
    const r = this.recentSends(chatId);
    const windowSec = Math.round(this.rate.windowMs / 1000);
    const retryIn = (oldest?: number) =>
      oldest == null ? windowSec : Math.max(1, Math.ceil((oldest + this.rate.windowMs - this.now()) / 1000));
    if (this.rate.perChat > 0 && r.chat >= this.rate.perChat) {
      return (
        `rate limited: ${r.chat}/${this.rate.perChat} sends to this target in the last ${windowSec}s ` +
        `(KAKAO_RATE_PER_CHAT); retry in ~${retryIn(r.oldestChat)}s. Do not retry in a loop.`
      );
    }
    if (this.rate.global > 0 && r.global >= this.rate.global) {
      return (
        `rate limited: ${r.global}/${this.rate.global} sends across all chats in the last ${windowSec}s ` +
        `(KAKAO_RATE_GLOBAL); retry in ~${retryIn(r.oldestGlobal)}s. Do not retry in a loop.`
      );
    }
    return undefined;
  }

  /** Which category a send to `chatId` falls into (independent of allow/deny). */
  categorize(chatId: string): SendCategory {
    return this.notifyChatId && chatId === this.notifyChatId ? 'notification' : 'message-as-you';
  }

  /** Whether the operator ceiling lets agents reach this room at all. Never human approval. */
  withinCeiling(chatId: string): boolean {
    return ROOM_ID.test(chatId) && BigInt(chatId) <= MAX_ID && (this.ceiling.size === 0 || this.ceiling.has(chatId));
  }

  /** Pure preflight for a room operation. Callers must still verify human approval before any external effect. */
  decide(chatId: string): PolicyDecision {
    const category = this.categorize(chatId);
    if (this.paused) return { allowed: false, category, reason: 'sending is paused (pause switch engaged)' };
    // Notifications skip per-message approval, never the operator's room ceiling.
    if (!this.withinCeiling(chatId)) {
      return { allowed: false, category, reason: 'room is outside the operator ceiling (KAKAO_ROOM_CEILING); human approval cannot override it' };
    }
    const limited = this.rateLimitReason(chatId);
    return limited ? { allowed: false, category, reason: limited }
      : { allowed: true, category, reason: 'within pause, ceiling and rate limits; approval is verified by the journaled operation' };
  }

  /** Take a rate slot and audit. Used only AFTER the journaled service verified approval. */
  authorize(chatId: string, textLength: number): PolicyDecision {
    return this.record(chatId, textLength, this.decide(chatId));
  }

  /**
   * Preflight for an operation on a user or the account rather than a room (open a 1:1 chat, friend/block,
   * profile update). `key` names the target, e.g. `create:user:<id>`; pause and the rate limit apply.
   */
  decideAction(key: string, label: string): PolicyDecision {
    const category: SendCategory = 'message-as-you';
    if (this.paused) return { allowed: false, category, reason: `${label} is paused (pause switch engaged)` };
    const limited = this.rateLimitReason(key);
    return limited ? { allowed: false, category, reason: limited } : { allowed: true, category, reason: `${label} within pause and rate limits` };
  }

  /** Take a rate slot and audit for decideAction. Used only after approval was verified. */
  authorizeAction(key: string, label: string): PolicyDecision {
    return this.record(key, 0, this.decideAction(key, label));
  }

  /** Audit a refused preflight (pause, ceiling, rate) so refused attempts appear too; takes no rate slot. */
  auditRefusal(target: string, decision: PolicyDecision, textLength = 0): void {
    if (decision.allowed) return;
    this.audit({ ts: new Date().toISOString(), chatId: target, category: decision.category, decision: 'denied', reason: decision.reason, textLength });
  }

  /** Count an allowed attempt against the rate window and append it to the audit log. */
  private record(chatId: string, textLength: number, decision: PolicyDecision): PolicyDecision {
    if (decision.allowed) {
      const cutoff = this.now() - this.rate.windowMs;
      this.sends = this.sends.filter((s) => s.at > cutoff);
      this.sends.push({ at: this.now(), chatId });
    }
    this.audit({
      ts: new Date().toISOString(),
      chatId,
      category: decision.category,
      decision: decision.allowed ? 'allowed' : 'denied',
      reason: decision.reason,
      textLength
    });
    return decision;
  }

  /** Append one audit entry (JSONL). Never throws into the send path. */
  audit(entry: AuditEntry): void {
    try {
      const { chatId, ts, category, decision, reason, textLength } = entry;
      const targetRef = createHmac('sha256', this.auditKey).update(chatId).digest('hex');
      fs.appendFileSync(this.auditLogPath, JSON.stringify({ ts, targetRef, category, decision, reason, textLength }) + '\n', { mode: 0o600 });
    } catch {
      process.stderr.write('[policy] WARN: audit storage write failed\n');
    }
  }

  setPaused(value: boolean): void {
    this.paused = value;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** A snapshot of the effective policy for the status tool and operation digests. */
  describe(): {
    paused: boolean;
    notifyChatId: string | null;
    ceiling: string[];
    auditLogPath: string;
    rateLimit: RateLimitConfig & { sendsInWindow: number };
  } {
    return {
      paused: this.paused,
      notifyChatId: this.notifyChatId ?? null,
      ceiling: [...this.ceiling].sort(),
      auditLogPath: this.auditLogPath,
      rateLimit: { ...this.rate, sendsInWindow: this.recentSends('').global }
    };
  }
}
