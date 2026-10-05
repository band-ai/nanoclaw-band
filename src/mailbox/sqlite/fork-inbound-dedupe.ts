/**
 * Fork: idempotent inbound insert. A replayed platform message (same id) is a
 * no-op when the stored row matches; a different payload under the same id throws.
 */
import type Database from 'better-sqlite3';

import type { InboundRecord } from '../model.js';

function normalizeDbValue(value: unknown): string | number | null {
  return value === undefined ? null : (value as string | number | null);
}

function existingMessageMatches(existing: Record<string, unknown>, record: InboundRecord): boolean {
  return (
    existing.kind === record.kind &&
    existing.timestamp === record.timestamp &&
    normalizeDbValue(existing.platform_id) === record.platformId &&
    normalizeDbValue(existing.channel_type) === record.channelType &&
    normalizeDbValue(existing.thread_id) === record.threadId &&
    existing.content === record.content &&
    normalizeDbValue(existing.process_after) === record.processAfter &&
    normalizeDbValue(existing.recurrence) === record.recurrence &&
    existing.trigger === (record.trigger ? 1 : 0) &&
    normalizeDbValue(existing.source_session_id) === record.sourceSessionId
  );
}

/** True when `id` is already stored with an identical payload; throws on a conflicting row. */
export function inboundAlreadyStored(db: Database.Database, id: string, record: InboundRecord): boolean {
  const existing = db.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return false;
  if (!existingMessageMatches(existing, record)) {
    throw new Error(`Conflicting messages_in row for id ${id}`);
  }
  return true;
}
