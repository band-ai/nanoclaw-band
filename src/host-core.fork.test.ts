/**
 * Fork: router route results + inbound delivery ledger (src/fork/inbound-route.ts),
 * exercised through the real routeInbound path. Setup mirrors host-core.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getInboundDelivery,
} from './db/index.js';
import { registerForkMigrations } from './db/migrations/fork.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { findSession } from './db/sessions.js';
import { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } from './channels/channel-registry.js';
import type { ChannelAdapter, InboundEvent } from './channels/adapter.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { routeInbound } from './router.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-fork' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-fork';

function now() {
  return new Date().toISOString();
}

/**
 * Minimal channel adapter. The delivery ledger is only written for adapters
 * with supportsDeliveryAck === true, so cases that assert ledger rows register
 * one of these for the channel type they route.
 */
function ackAdapter(channelType: string, supportsDeliveryAck = true): ChannelAdapter {
  let connected = false;
  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    supportsDeliveryAck,
    async setup() {
      connected = true;
    },
    async teardown() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    async deliver() {
      return undefined;
    },
  };
}

async function registerAckAdapters(channelTypes: string[], supportsDeliveryAck = true): Promise<void> {
  for (const ct of channelTypes) {
    registerChannelAdapter(ct, { factory: () => ackAdapter(ct, supportsDeliveryAck) });
  }
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

// inbound_delivery_ledger is a fork migration registered outside the core array
// (see db/migrations/fork.ts) — register it once before migrations run, mirroring
// src/index.ts startup.
registerForkMigrations();

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('router — route results + delivery ledger', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    await registerAckAdapters(['discord', 'slack', 'band']);
  });

  afterEach(async () => {
    await teardownChannelAdapters();
  });

  it('returns persisted and records the session ids in the ledger', async () => {
    const result = await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello agent!' }),
        timestamp: now(),
      },
    });

    const session = await findSession('mg-1', null);
    expect(result).toEqual({
      status: 'persisted',
      platformMessageId: 'msg-in-1',
      sessionIds: [session!.id],
      sessionMessageIds: ['msg-in-1:ag-1'],
    });
    const ledger = await getInboundDelivery({
      channelType: 'discord',
      platformId: 'chan-123',
      platformMessageId: 'msg-in-1',
    });
    expect(ledger?.status).toBe('persisted');
    expect(JSON.parse(ledger!.session_ids_json!)).toEqual([session!.id]);
  });

  it('audits unaddressed chatter on an unknown channel without creating a messaging group', async () => {
    const plainResult = await routeInbound({
      channelType: 'slack',
      platformId: 'C-PLAIN',
      threadId: null,
      message: {
        id: 'msg-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    });
    expect(plainResult).toMatchObject({ status: 'dropped', reason: 'no_messaging_group', retryable: true });
    expect(await getMessagingGroupByPlatform('slack', 'C-PLAIN')).toBeUndefined();
    expect(
      (await getInboundDelivery({ channelType: 'slack', platformId: 'C-PLAIN', platformMessageId: 'msg-plain' }))
        ?.status,
    ).toBe('retrying');

    const mentionedResult = await routeInbound({
      channelType: 'slack',
      platformId: 'C-MENTIONED',
      threadId: null,
      message: {
        id: 'msg-mentioned',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
      },
    });
    expect(mentionedResult).toMatchObject({ status: 'dropped', reason: 'no_agent_wired', retryable: true });
    expect(await getMessagingGroupByPlatform('slack', 'C-MENTIONED')).toBeDefined();
  });

  it('audits non-mention messages in known-but-unwired rooms', async () => {
    await createMessagingGroup({
      id: 'mg-unwired',
      channel_type: 'band',
      platform_id: 'band:room-unwired',
      name: 'Unwired Band Room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const result = await routeInbound({
      channelType: 'band',
      platformId: 'band:room-unwired',
      threadId: null,
      message: {
        id: 'band-msg-unwired-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Band User', text: 'hello?' }),
        timestamp: now(),
      },
    });

    expect(result).toMatchObject({ status: 'dropped', reason: 'no_agent_wired_unmentioned', retryable: true });
    expect(
      (
        await getInboundDelivery({
          channelType: 'band',
          platformId: 'band:room-unwired',
          platformMessageId: 'band-msg-unwired-plain',
        })
      )?.status,
    ).toBe('retrying');
  });

  it('dedupes repeated platform message ids after persistence', async () => {
    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-duplicate-platform-id',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'deliver once' }),
        timestamp: now(),
      },
    };

    const first = await routeInbound(event);
    const second = await routeInbound(event);
    expect(first.status).toBe('persisted');
    expect(second).toEqual(first);

    const session = (await findSession('mg-1', null))!;
    const db = new Database(inboundDbPath('ag-1', session.id));
    const rows = db.prepare('SELECT * FROM messages_in WHERE id = ?').all('msg-duplicate-platform-id:ag-1');
    db.close();
    expect(rows).toHaveLength(1);
  });

  it('does NOT write ledger rows for non-ACK adapters', async () => {
    await registerAckAdapters(['no-ack-ch'], false);
    await createMessagingGroup({
      id: 'mg-noack',
      channel_type: 'no-ack-ch',
      platform_id: 'noack-room',
      instance: 'no-ack-ch',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-noack',
      messaging_group_id: 'mg-noack',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const result = await routeInbound({
      channelType: 'no-ack-ch',
      platformId: 'noack-room',
      threadId: null,
      message: { id: 'msg-noack-1', kind: 'chat', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });
    expect(result.status).toBe('persisted');
    const ledger = await getInboundDelivery({
      channelType: 'no-ack-ch',
      platformId: 'noack-room',
      platformMessageId: 'msg-noack-1',
    });
    expect(ledger).toBeUndefined();
  });

  it('returns audited:false on drops from non-ACK adapters', async () => {
    // Unknown channel with no adapter — ackMode is false.
    const result = await routeInbound({
      channelType: 'no-adapter-ch',
      platformId: 'some-room',
      threadId: null,
      message: { id: 'msg-drop-noack', kind: 'chat', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });
    expect(result.status).toBe('dropped');
    if (result.status === 'dropped') expect(result.audited).toBe(false);
  });
});
