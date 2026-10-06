/**
 * Fork: absolute-ceiling kill reason for the SLA sweep in reconcile-session.ts.
 *
 * Returns 'absolute-ceiling graceful' when the adapter handling the session's
 * messaging group declares needsGracefulStop, so stopGraceForReason grants the
 * long shutdown window (Band memory consolidation) instead of the 10s fast one.
 * The bookkeeping reason passed to resetStuckProcessingRows stays plain
 * 'absolute-ceiling'.
 */
import { getChannelAdapter } from '../channels/channel-registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import type { Session } from '../types.js';
import { GRACEFUL_STOP_TAG } from './stop-grace.js';

async function sessionNeedsGracefulStop(session: Session): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return false;
  const adapter = getChannelAdapter(mg.instance ?? mg.channel_type);
  return adapter?.needsGracefulStop === true;
}

export async function absoluteCeilingStopReason(session: Session): Promise<string> {
  return (await sessionNeedsGracefulStop(session)) ? `absolute-ceiling ${GRACEFUL_STOP_TAG}` : 'absolute-ceiling';
}
