// Test-only: approve prepared operations through the real ApprovalStore, exactly as the MCP client
// dialog records a human confirmation. Not exported from the package.
import { ApprovalStore, ApproverRegistry } from './approvals.ts';
import type { AgentSendJournal } from './agent-send.ts';

export function fixtureApprovals(journal: AgentSendJournal, dataDir: string, now: () => number = Date.now) {
  const store = new ApprovalStore(journal, new ApproverRegistry(dataDir), now, { clientConfirmations: true });
  return {
    store,
    /** Record the human's approval of exactly this prepared envelope. */
    approve(prepared: { requestId: string; signingText?: string }): void {
      if (typeof prepared.signingText !== 'string') throw new Error('fixture: prepared operation has no signingText');
      store.recordClientConfirmation(prepared.requestId, store.envelopeDigest(prepared.signingText), 'fixture');
    }
  };
}
