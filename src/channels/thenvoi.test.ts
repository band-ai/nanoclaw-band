import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundRouteResult } from './adapter.js';
import type { InboundDeliveryKey } from '../db/index.js';

interface QueuedEvent {
  type: string;
  roomId: string | null;
  payload: Record<string, unknown>;
}

const fakeLinks: FakeThenvoiLink[] = [];
let closeTestDb: (() => void) | null = null;

class FakeThenvoiLink implements AsyncIterable<QueuedEvent> {
  public readonly rest = {
    createChatMessage: vi.fn(async () => ({ id: 'platform-out-1' })),
  };
  public readonly markProcessing = vi.fn(async () => {});
  public readonly markProcessed = vi.fn(async () => {});
  public readonly connect = vi.fn(async () => {});
  public readonly disconnect = vi.fn(async () => {});
  public readonly subscribeAgentRooms = vi.fn(async () => {});
  public readonly subscribeRoom = vi.fn(async (_roomId: string) => {});
  public readonly listAllChats = vi.fn(async () => [{ id: 'room-1', title: 'Room 1', type: 'direct' }]);
  private queue: QueuedEvent[] = [];
  private waiters: Array<(event: IteratorResult<QueuedEvent>) => void> = [];

  public constructor() {
    fakeLinks.push(this);
  }

  public emit(event: QueuedEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  public async runForever(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  public [Symbol.asyncIterator](): AsyncIterator<QueuedEvent> {
    return {
      next: async () => {
        const event = this.queue.shift();
        if (event) return { done: false, value: event };
        return new Promise<IteratorResult<QueuedEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

vi.mock('@thenvoi/sdk', () => ({
  ThenvoiLink: FakeThenvoiLink,
}));

function setThenvoiEnv(): void {
  process.env.THENVOI_AGENT_ID = 'agent-1';
  process.env.THENVOI_API_KEY = 'secret';
  process.env.THENVOI_BASE_URL = 'https://band.example.test';
}

function clearThenvoiEnv(): void {
  delete process.env.THENVOI_AGENT_ID;
  delete process.env.THENVOI_API_KEY;
  delete process.env.THENVOI_BASE_URL;
  delete process.env.THENVOI_MEMORY_TOOLS;
  delete process.env.THENVOI_MEMORY_LOAD_ON_START;
  delete process.env.THENVOI_MEMORY_CONSOLIDATION;
  delete process.env.THENVOI_CONTACT_STRATEGY;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe('thenvoi channel adapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    fakeLinks.length = 0;
    clearThenvoiEnv();
    const { closeDb, initTestDb, runMigrations } = await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    closeTestDb = closeDb;
  });

  afterEach(() => {
    closeTestDb?.();
    closeTestDb = null;
    clearThenvoiEnv();
  });

  it('skips adapter registration when credentials are missing', async () => {
    await import('./thenvoi.js');
    const { initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(getActiveAdapters().some((adapter) => adapter.channelType === 'thenvoi')).toBe(false);
  });

  it('marks Band messages processed only after a persisted route result', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'msg-1',
      sessionIds: ['sess-1'],
      sessionMessageIds: ['msg-1:ag-1'],
    };
    const { beginInboundDelivery, getInboundDelivery, markInboundDeliveryPersisted } = await import('../db/index.js');
    const onInbound = vi.fn(async (platformId: string, threadId: string | null) => {
      const key: InboundDeliveryKey = { channelType: 'thenvoi', platformId, platformMessageId: 'msg-1' };
      beginInboundDelivery(key, threadId);
      markInboundDeliveryPersisted(key, {
        sessionIds: result.sessionIds,
        sessionMessageIds: result.sessionMessageIds,
      });
      return result;
    });

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'msg-1',
        content: 'hello',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        sender_name: 'User One',
        inserted_at: new Date().toISOString(),
      },
    });

    await waitFor(() => fakeLinks[0].markProcessed.mock.calls.length === 1);
    expect(onInbound).toHaveBeenCalledWith(
      'thenvoi:room-1',
      null,
      expect.objectContaining({ id: 'msg-1', content: expect.objectContaining({ text: 'hello' }) }),
    );
    expect(fakeLinks[0].markProcessing).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(fakeLinks[0].markProcessed).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(
      getInboundDelivery({ channelType: 'thenvoi', platformId: 'thenvoi:room-1', platformMessageId: 'msg-1' })?.status,
    ).toBe('processed');
  });

  it('delivers generic outbound chat rows through Band REST fallback', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'persisted',
      platformMessageId: 'unused',
      sessionIds: [],
      sessionMessageIds: [],
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    const adapter = getChannelAdapter('thenvoi');
    await expect(
      adapter!.deliver('thenvoi:room-1', null, { kind: 'chat', content: { text: 'hello from agent' } }),
    ).resolves.toBe('platform-out-1');
    expect(fakeLinks[0].rest.createChatMessage).toHaveBeenCalledWith('room-1', {
      content: 'hello from agent',
      messageType: 'text',
      metadata: { source: 'nanoclaw_fallback' },
    });
  });

  it('injects Band env for HTTPS sessions without direct API key', async () => {
    setThenvoiEnv();
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_LOAD_ON_START = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    await import('./thenvoi.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('thenvoi')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'thenvoi',
        platform_id: 'thenvoi:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toEqual(
      expect.objectContaining({
        NANOCLAW_CHANNEL: 'thenvoi',
        THENVOI_ROOM_ID: 'room-1',
        THENVOI_AGENT_ID: 'agent-1',
        THENVOI_REST_URL: 'https://band.example.test',
        THENVOI_MEMORY_TOOLS: 'true',
        THENVOI_MEMORY_LOAD_ON_START: 'true',
        THENVOI_MEMORY_CONSOLIDATION: 'false',
      }),
    );
    expect(config.env).not.toHaveProperty('THENVOI_API_KEY');
  });

  it('injects direct Band API key only for local HTTP sessions', async () => {
    setThenvoiEnv();
    process.env.THENVOI_BASE_URL = 'http://localhost:4000';
    await import('./thenvoi.js');
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');

    const config = await getChannelContainerConfig('thenvoi')!({
      session: {
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: {
        id: 'mg-1',
        channel_type: 'thenvoi',
        platform_id: 'thenvoi:room-1',
        name: 'Room 1',
        is_group: 1,
        unknown_sender_policy: 'public',
        denied_at: null,
        created_at: new Date().toISOString(),
      },
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toEqual(
      expect.objectContaining({
        THENVOI_REST_URL: 'http://host.docker.internal:4000',
        THENVOI_API_KEY: 'secret',
      }),
    );
  });

  it('does not mark Band messages processed after retryable drops', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'dropped',
      platformMessageId: 'msg-drop',
      reason: 'no_agent_wired_unmentioned',
      audited: true,
      retryable: true,
      intentional: false,
    };

    await initChannelAdapters(() => ({
      onInbound: async () => result,
      onInboundEvent: async () => result,
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'message_created',
      roomId: 'room-1',
      payload: {
        id: 'msg-drop',
        content: 'hello?',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        inserted_at: new Date().toISOString(),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeLinks[0].markProcessing).not.toHaveBeenCalled();
    expect(fakeLinks[0].markProcessed).not.toHaveBeenCalled();
  });
});
