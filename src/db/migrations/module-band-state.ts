import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Band-owned: creates the module_state KV table.
 *
 * Lives in the Band channel-migration set (registered by src/channels/band.ts),
 * not in the core barrel. A Band-free install never runs this. Existing origin
 * installs that already have module_state from migration 019 see a no-op
 * (CREATE TABLE IF NOT EXISTS).
 *
 * version: 100 — channel migrations use 100+ to avoid colliding with core's
 * current ceiling (~20) while leaving room for future core migrations.
 */
export const moduleBandState: Migration = {
  version: 100,
  name: 'module-band-state',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_state (
        module_name TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (module_name, key)
      );
    `);
  },
};
