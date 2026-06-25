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

  it('is created when Band migrations are registered', async () => {
    // Simulate band.ts side-effect import by calling registerChannelMigrations
    // with the real Band migration list.
    const { moduleBandState } = await import('./migrations/module-band-state.js');
    registerChannelMigrations('band-m2-test', [moduleBandState]);
    const db = initTestDb();
    runMigrations(db);
    expect(hasTable(db, 'module_state')).toBe(true);
  });

  it('is idempotent when module_state already exists (existing origin DB)', async () => {
    // Pre-create module_state (simulates an existing origin DB that had it
    // from migration 019). CREATE TABLE IF NOT EXISTS makes re-running a no-op.
    const db = initTestDb();
    db.exec(
      `CREATE TABLE module_state (module_name TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (module_name, key));`,
    );

    const { moduleBandState } = await import('./migrations/module-band-state.js');
    registerChannelMigrations('band-idempotent', [moduleBandState]);
    expect(() => runMigrations(db)).not.toThrow();
    expect(hasTable(db, 'module_state')).toBe(true);
  });
});
