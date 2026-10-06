import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  initSqliteTestDb,
  closeDb,
  runMigrations,
  beginInboundDelivery,
  canPlatformProcessFromLedger,
  getInboundDelivery,
  markInboundDeliveryDropped,
  markInboundDeliveryPersisted,
  markInboundDeliveryProcessed,
  deleteModuleState,
  getModuleState,
  listModuleState,
  setModuleState,
} from './index.js';
import { registerChannelMigrations } from './migrations/index.js';
import { registerForkMigrations } from './migrations/fork.js';

// The inbound_delivery_ledger tests below rely on the fork's route-foundation
// migration, which registers via the fork registry (not the core array).
registerForkMigrations();

// module_state is not in core schema — it's created by a channel migration
// (Band, in production). Register a local one so the generic module-state.ts
// helper has its table here without coupling this core test to the Band channel.
// Doubles as coverage for the channel-migration registry seam.
registerChannelMigrations('db-v2-test', [
  {
    version: 1,
    name: 'db-v2-test-module-state',
    sqliteOnly: true,
    up: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS module_state (
           module_name TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
           updated_at TEXT NOT NULL, PRIMARY KEY (module_name, key));`,
      );
    },
  },
]);

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('route foundation state', () => {
  it('tracks inbound delivery by platform message id', async () => {
    const key = { channelType: 'thenvoi', platformId: 'thenvoi:room-1', platformMessageId: 'band-msg-1' };

    const received = await beginInboundDelivery(key, null);
    expect(received.status).toBe('received');
    expect(received.retry_count).toBe(0);

    await beginInboundDelivery(key, null);
    const retried = (await getInboundDelivery(key))!;
    expect(retried.retry_count).toBe(1);

    const persisted = await markInboundDeliveryPersisted(key, {
      sessionIds: ['sess-1'],
      sessionMessageIds: ['band-msg-1:ag-1'],
    });
    expect(persisted.status).toBe('persisted');
    expect(canPlatformProcessFromLedger(persisted)).toBe(true);
    expect(JSON.parse(persisted.session_ids_json!)).toEqual(['sess-1']);

    const processed = await markInboundDeliveryProcessed(key);
    expect(processed.status).toBe('processed');
    expect(processed.processed_at).toBeTruthy();
  });

  it('distinguishes retryable drops from intentional audited drops', async () => {
    const retryable = { channelType: 'thenvoi', platformId: 'thenvoi:room-2', platformMessageId: 'band-msg-2' };
    await beginInboundDelivery(retryable, null);
    const retryableDrop = await markInboundDeliveryDropped(retryable, {
      reason: 'no_agent_wired_unmentioned',
      intentional: false,
      retryable: true,
    });
    expect(retryableDrop.status).toBe('retrying');
    expect(canPlatformProcessFromLedger(retryableDrop)).toBe(false);

    const intentional = { channelType: 'thenvoi', platformId: 'thenvoi:room-3', platformMessageId: 'band-msg-3' };
    await beginInboundDelivery(intentional, null);
    const auditedDrop = await markInboundDeliveryDropped(intentional, {
      reason: 'channel_denied',
      intentional: true,
    });
    expect(auditedDrop.status).toBe('intentionally_dropped');
    expect(canPlatformProcessFromLedger(auditedDrop)).toBe(true);
  });

  it('stores module state as JSON by module and key', async () => {
    await setModuleState('thenvoi', 'main-room', { roomId: 'room-1', ready: true });
    expect(await getModuleState('thenvoi', 'main-room')).toEqual({ roomId: 'room-1', ready: true });
    expect(await listModuleState('thenvoi')).toHaveLength(1);

    await deleteModuleState('thenvoi', 'main-room');
    expect(await getModuleState('thenvoi', 'main-room')).toBeUndefined();
  });
});
