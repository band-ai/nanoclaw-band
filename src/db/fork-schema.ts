/**
 * Fork: reference copy of the fork-added central-DB tables (see schema.ts for core).
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const FORK_SCHEMA = `
-- Per-message inbound platform delivery state. This is the ACK/replay audit
-- source for channel adapters that need to know whether a platform message was
-- durably persisted before emitting an external processed marker.
CREATE TABLE inbound_delivery_ledger (
  channel_type        TEXT NOT NULL,
  platform_id         TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  thread_id           TEXT,
  status              TEXT NOT NULL,
  reason              TEXT,
  retryable           INTEGER NOT NULL DEFAULT 0,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_retry_at       TEXT,
  session_ids_json    TEXT,
  session_message_ids_json TEXT,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  processed_at        TEXT,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id, platform_message_id)
);

-- Cross-module state (Band-owned). Managed by Band channel migrations
-- (module-band-state + band-rename in src/channels/band.ts). Absent on
-- Band-free installs.
CREATE TABLE module_state (
  module_name TEXT NOT NULL,
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (module_name, key)
);
`;
