// Shows the daemon's confirmation dialogs for actions the person starts in this GUI, and returns their
// answer. The daemon renders the text, picks the confirmation code and decides what the answer allows;
// this relay only carries them. It never fills in the code: typing it is what makes it an approval.
import type { ApprovalAnswer, ApprovalDialog } from './mcp-bridge.ts';

/** The daemon cancels an unanswered dialog after 120 s; close ours first so the page never shows a dead one. */
export const DIALOG_TIMEOUT_MS = 110_000;
const CODE_MAX = 16;

export interface ApprovalRelayDeps {
  answer(id: string, answer: ApprovalAnswer): boolean;
  /** True while at least one GUI page is connected and could show the dialog. */
  hasViewers(): boolean;
  notify(event: 'approval-request' | 'approval-closed', data: unknown): void;
  timeoutMs?: number;
}

export class ApprovalRelay {
  private readonly open = new Map<string, { dialog: ApprovalDialog; timer: NodeJS.Timeout }>();
  private readonly deps: ApprovalRelayDeps;
  constructor(deps: ApprovalRelayDeps) { this.deps = deps; }

  /** A dialog from the daemon. Nobody watching means nobody can approve: cancel at once. */
  request(dialog: ApprovalDialog): void {
    if (!this.deps.hasViewers()) { this.deps.answer(dialog.id, { action: 'cancel' }); return; }
    const timer = setTimeout(() => this.settle(dialog.id, { action: 'cancel' }), this.deps.timeoutMs ?? DIALOG_TIMEOUT_MS);
    timer.unref();
    this.open.set(dialog.id, { dialog, timer });
    this.deps.notify('approval-request', dialog);
  }

  /** Dialogs still waiting, for a page that connects or reloads. */
  list(): ApprovalDialog[] { return [...this.open.values()].map(o => o.dialog); }

  /** The bridge closed a dialog (answered, or the connection dropped). */
  closed(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    clearTimeout(o.timer);
    this.open.delete(id);
    this.deps.notify('approval-closed', { id });
  }

  /** A browser answer. Returns an error string for a malformed or stale answer. */
  answerFromPage(body: unknown): string | undefined {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.id !== 'string' || !this.open.has(b.id)) return 'This approval is no longer open';
    let answer: ApprovalAnswer;
    if (b.action === 'accept') {
      if (typeof b.code !== 'string' || !b.code.trim() || b.code.length > CODE_MAX) return 'Type the confirmation code shown in the dialog';
      answer = { action: 'accept', code: b.code.trim(), remember: b.remember === true };
    } else if (b.action === 'decline' || b.action === 'cancel') {
      answer = { action: b.action };
    } else return 'action must be accept, decline or cancel';
    this.settle(b.id, answer);
    return undefined;
  }

  private settle(id: string, answer: ApprovalAnswer): void {
    const o = this.open.get(id);
    if (!o) return;
    clearTimeout(o.timer);
    this.open.delete(id);
    this.deps.answer(id, answer);
    this.deps.notify('approval-closed', { id });
  }
}
