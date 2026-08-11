/**
 * Fork migration registry (see fork.ts): the fork's own migrations register
 * through the channel-migration registry instead of the upstream core array, so
 * an upstream sync never conflicts on them. These tests pin that contract.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { initTestDb, closeDb, hasTable } from '../connection.js';
import { runMigrations, migrations, _resetChannelMigrationsForTesting } from './index.js';
import { registerForkMigrations, forkMigrations } from './fork.js';

afterEach(() => {
  closeDb();
  _resetChannelMigrationsForTesting();
});

describe('fork migration registry', () => {
  it('leaves fork migrations OUT of the upstream core array (the conflict seam)', () => {
    // If this fails, a fork migration was spliced back into index.ts's array —
    // reintroducing the exact merge conflict this indirection removes.
    const coreNames = migrations.map((m) => m.name);
    for (const m of forkMigrations) {
      expect(coreNames).not.toContain(m.name);
    }
  });

  it('does not create the fork ledger on a base install (fork not registered)', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(hasTable(db, 'inbound_delivery_ledger')).toBe(false);
  });

  it('creates inbound_delivery_ledger once fork migrations are registered', () => {
    registerForkMigrations();
    const db = initTestDb();
    runMigrations(db);

    expect(hasTable(db, 'inbound_delivery_ledger')).toBe(true);
    const names = (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('route-foundation-state');
  });

  it('is idempotent — a second run does not re-apply', () => {
    registerForkMigrations();
    const db = initTestDb();
    runMigrations(db);
    runMigrations(db); // already applied (keyed on name) — must be a no-op
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM schema_version WHERE name = 'route-foundation-state'").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  it('pins the migration name (installs key idempotency on it — never rename)', () => {
    expect(forkMigrations.map((m) => m.name)).toContain('route-foundation-state');
  });
});
