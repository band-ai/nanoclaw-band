import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Fork-owned migration. Registered via registerForkMigrations() (fork.ts),
// NOT added to the core `migrations` array in index.ts — that array is the
// upstream seam that caused the sync conflict. Version uses the reserved 900+
// fork range purely as a visual marker; uniqueness is by `name`, so the number
// is cosmetic and the `name` must stay 'route-foundation-state' forever (installs
// key idempotency on it).
export const routeFoundationState: Migration = {
  version: 900,
  name: 'route-foundation-state',
  sqliteOnly: true,
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_delivery_ledger (
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        thread_id           TEXT,
        status              TEXT NOT NULL,
                            -- received | persisted | processed | retrying | dead_lettered | intentionally_dropped | terminal_failed
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

      CREATE INDEX IF NOT EXISTS idx_inbound_delivery_status
        ON inbound_delivery_ledger(status, next_retry_at);

      CREATE INDEX IF NOT EXISTS idx_inbound_delivery_last_seen
        ON inbound_delivery_ledger(last_seen);
    `);
  },
};
