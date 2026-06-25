/**
 * Channel-migration registry (C1 seam): channels register their own migrations;
 * runMigrations applies them after core, keyed on `name`. A base install that
 * never registers the channel never runs its migrations.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { initTestDb, closeDb, hasTable } from './connection.js';
import { runMigrations, registerChannelMigrations, _resetChannelMigrationsForTesting } from './migrations/index.js';

afterEach(() => {
  closeDb();
  // The channel-migration registry is a module-level Map; clear it so each
  // test starts from an empty registry and re-registering a real migration
  // (e.g. module-band-state) can't surface twice in allMigrations().
  _resetChannelMigrationsForTesting();
});

describe('channel migration registry', () => {
  it('does not create a channel table when no channel migration is registered', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(hasTable(db, 'test_channel_only_table')).toBe(false);
  });

  it('creates a channel table once its migration is registered, then run', () => {
    registerChannelMigrations('test-channel', [
      {
        version: 200,
        name: 'test-channel-table',
        up: (db) =>
          db.exec('CREATE TABLE IF NOT EXISTS test_channel_only_table (id TEXT PRIMARY KEY, value TEXT NOT NULL);'),
      },
    ]);

    const db = initTestDb();
    runMigrations(db);

    expect(hasTable(db, 'test_channel_only_table')).toBe(true);
    const names = (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('test-channel-table');
  });

  it('does not re-run an already-applied channel migration', () => {
    let runs = 0;
    registerChannelMigrations('idempotent-channel', [
      {
        version: 201,
        name: 'idempotent-channel-table',
        up: (db) => {
          runs += 1;
          db.exec('CREATE TABLE IF NOT EXISTS idempotent_channel_table (id TEXT PRIMARY KEY);');
        },
      },
    ]);

    const db = initTestDb();
    runMigrations(db);
    runMigrations(db); // second pass — already applied, must not re-run
    expect(runs).toBe(1);
  });
});

describe('module_state ownership (M2)', () => {
  it('is absent on a base (Band-free) install', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(hasTable(db, 'module_state')).toBe(false);
  });

  // The Band-specific cases — that registering the real `module-band-state`
  // migration creates `module_state`, and that it's idempotent over an existing
  // table — live in src/channels/band.test.ts. Keeping them out of this generic
  // registry test is what lets a Band-free core compile without importing any
  // Band migration file (the additivity guarantee).
});
