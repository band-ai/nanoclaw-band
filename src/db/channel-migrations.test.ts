/**
 * Channel-migration registry (C1 seam): channels register their own migrations;
 * runMigrations applies them after core, keyed on `name`. A base install that
 * never registers the channel never runs its migrations.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { initTestDb, closeDb, hasTable } from './connection.js';
import { runMigrations, registerChannelMigrations, _resetChannelMigrationsForTesting } from './migrations/index.js';

afterEach(async () => {
  await closeDb();
  // The channel-migration registry is a module-level Map; clear it so each
  // test starts from an empty registry and re-registering a real migration
  // (e.g. module-band-state) can't surface twice in getRegisteredMigrations().
  _resetChannelMigrationsForTesting();
});

describe('channel migration registry', () => {
  it('does not create a channel table when no channel migration is registered', async () => {
    const db = await initTestDb();
    await runMigrations(db);
    expect(await hasTable(db, 'test_channel_only_table')).toBe(false);
  });

  it('creates a channel table once its migration is registered, then run', async () => {
    registerChannelMigrations('test-channel', [
      {
        version: 200,
        name: 'test-channel-table',
        up: async (db) =>
          db.exec('CREATE TABLE IF NOT EXISTS test_channel_only_table (id TEXT PRIMARY KEY, value TEXT NOT NULL);'),
      },
    ]);

    const db = await initTestDb();
    await runMigrations(db);

    expect(await hasTable(db, 'test_channel_only_table')).toBe(true);
    const names = (await db.all<{ name: string }>('SELECT name FROM schema_version')).map((r) => r.name);
    expect(names).toContain('test-channel-table');
  });

  it('does not re-run an already-applied channel migration', async () => {
    let runs = 0;
    registerChannelMigrations('idempotent-channel', [
      {
        version: 201,
        name: 'idempotent-channel-table',
        up: async (db) => {
          runs += 1;
          await db.exec('CREATE TABLE IF NOT EXISTS idempotent_channel_table (id TEXT PRIMARY KEY);');
        },
      },
    ]);

    const db = await initTestDb();
    await runMigrations(db);
    await runMigrations(db); // second pass — already applied, must not re-run
    expect(runs).toBe(1);
  });
});

describe('module_state ownership (M2)', () => {
  it('is absent on a base (Band-free) install', async () => {
    const db = await initTestDb();
    await runMigrations(db);
    expect(await hasTable(db, 'module_state')).toBe(false);
  });

  // The Band-specific cases — that registering the real `module-band-state`
  // migration creates `module_state`, and that it's idempotent over an existing
  // table — live in src/channels/band.test.ts. Keeping them out of this generic
  // suite means this file never has to know Band exists.
});
