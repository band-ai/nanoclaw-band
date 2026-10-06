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
import { forkMigrations } from './fork.js';
import type { Migration } from './index.js';

/** Key the fork's own migrations (fork.ts) register under. */
export const FORK_KEY = 'fork';

const channelMigrations = new Map<string, Migration[]>();

export function hasChannelMigrations(channel: string): boolean {
  return channelMigrations.has(channel);
}

export function registerChannelMigrations(channel: string, list: Migration[]): void {
  if (channelMigrations.has(channel)) {
    throw new Error(`Channel migrations already registered: ${channel}`);
  }
  // Channel migrations may rewrite fork tables (Band's rename touches
  // inbound_delivery_ledger), and channels register on import — before the
  // host or any script runs migrations. The first channel therefore pulls the
  // fork's set in ahead of itself, so no entry point can run a channel's
  // migrations without the tables they build on.
  if (channel !== FORK_KEY && !channelMigrations.has(FORK_KEY)) {
    channelMigrations.set(FORK_KEY, forkMigrations);
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
