import type { ReadApproval, ReadGrantTool } from '@kakao-max/core';

/** Plain read tools carry only a grant reference; an agent-supplied confirmRead is never forwarded. */
export function readGrant(args: Record<string, unknown>, tool: ReadGrantTool): ReadApproval {
  return typeof args.readGrantId === 'string' ? { readGrant: { id: args.readGrantId, tool } } : {};
}
