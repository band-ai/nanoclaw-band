/** Fork-owned session queries (Band adapter). Re-exported from sessions.ts and the db barrel. */
import type { Session } from '../types.js';
import { getDb } from './connection.js';

export async function getActiveSessionsByMessagingGroup(messagingGroupId: string): Promise<Session[]> {
  return getDb().all<Session>(
    "SELECT * FROM sessions WHERE messaging_group_id = ? AND status = 'active'",
    messagingGroupId,
  );
}

export async function closeActiveSessionsForMessagingGroup(messagingGroupId: string): Promise<number> {
  const result = await getDb().run(
    "UPDATE sessions SET status = 'closed', container_status = 'stopped', last_active = ? WHERE messaging_group_id = ? AND status = 'active'",
    new Date().toISOString(),
    messagingGroupId,
  );
  return result.changes;
}
