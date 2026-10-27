// One call per write: prepare (idempotent for the same requestId and payload), then commit.
//
// When human approval is missing the commit throws APPROVAL_REQUIRED carrying the exact approval text.
// A client that supports confirmation dialogs asks the person inside the same call and retries it with
// the same arguments, so the agent-chosen requestId must be stable; a server-generated ID would change on
// retry and never match the recorded approval. Other clients get the passkey link (when enabled) in the
// error and call the same tool again with the same requestId after the person approves.
import { KakaoError, toKakaoError } from '@kakao-max/core';
import { withApproval } from '../approval-center.ts';

export const REQUEST_ID = { type: 'string', description: 'Stable UUID you choose for this exact operation. Call again with the same requestId and arguments to continue after approval; never replace it after an uncertain outcome.' } as const;

export async function prepareAndCommit<R>(o: {
  prepare: () => object | Promise<object>;
  commit: () => Promise<R>;
  /** Image previews for the passkey page; wiped after the approval center keeps its verified copies. */
  media?: () => Buffer[];
}): Promise<R> {
  const prepared = await o.prepare();
  try {
    return await o.commit();
  } catch (e) {
    const err = toKakaoError(e);
    if (err.code !== 'APPROVAL_REQUIRED') throw err;
    const media = o.media?.() ?? [];
    let passkey: unknown;
    try { passkey = withApproval(prepared as Record<string, unknown>, media).approval; } finally { for (const b of media) b.fill(0); }
    if (!passkey) throw err;
    throw new KakaoError('APPROVAL_REQUIRED', `${err.message}. Share details.passkey.approvalUrl with the person, wait_for_approval, then call this tool again with the same requestId`,
      { details: { ...err.details, passkey } });
  }
}
