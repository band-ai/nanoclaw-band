/**
 * Fork-owned channel-migration registry.
 *
 * Channels (Band, etc.) register their own migrations here on import.
 * getRegisteredMigrations() in index.ts appends them after core and module
 * migrations, keyed on `name` like core — so an already-applied channel
 * migration is skipped by name, and a base install that never registers a
 * channel never runs its migrations. Re-exported from index.ts so channel
 * code imports `registerChannelMigrations` from '../db/migrations/index.js'.
 */
import type { Migration } from './index.js';

const channelMigrations = new Map<string, Migration[]>();

export function registerChannelMigrations(channel: string, list: Migration[]): void {
  if (channelMigrations.has(channel)) {
    throw new Error(`Channel migrations already registered: ${channel}`);
  }
  channelMigrations.set(channel, list);
}

/** Test-only: clears the channel-migration registry. The registry is a
 *  module-level Map, so without this it leaks across `it()` blocks in the
 *  same file — re-registering the same real migration (e.g. module-band-state)
 *  would surface it twice in getRegisteredMigrations() and violate schema_version's
 *  UNIQUE(name). Never call this in production code paths. */
export function _resetChannelMigrationsForTesting(): void {
  channelMigrations.clear();
}

export function getChannelMigrations(): Migration[] {
  return [...channelMigrations.values()].flat();
}
