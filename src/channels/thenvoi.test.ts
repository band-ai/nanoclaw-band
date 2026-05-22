import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundMessage, InboundRouteResult } from './adapter.js';
import type { InboundDeliveryKey } from '../db/index.js';

interface QueuedEvent {
  type: string;
  roomId: string | null;
  payload: Record<string, unknown>;
}

const fakeLinks: FakeThenvoiLink[] = [];
const fakeRestClients: FakeThenvoiClient[] = [];
let closeTestDb: (() => void) | null = null;

class FakeThenvoiClient {
  public readonly agentApiIdentity = {
    getAgentMe: vi.fn(async () => ({ data: { owner_uuid: 'owner-1' } })),
  };
  public readonly agentApiMessages = {
    createAgentChatMessage: vi.fn(async () => ({ data: { id: 'platform-out-1' } })),
  };
  public readonly agentApiContacts = {
    respondToAgentContactRequest: vi.fn(async () => ({ data: { ok: true } })),
  };
  public readonly agentApiChats = {
    createAgentChat: vi.fn(async () => ({ data: { id: 'hub-room-1', inserted_at: '', updated_at: '' } })),
  };
  public readonly agentApiParticipants = {
    addAgentChatParticipant: vi.fn(async () => ({ data: { ok: true } })),
  };
  public readonly agentApiEvents = {
    createAgentChatEvent: vi.fn(async () => ({ data: { ok: true } })),
  };
  public readonly agentApiMemories = {
    listAgentMemories: vi.fn(async (_args: { subject_id: string; scope: string }) => ({
      data: { data: [] as Array<{ type?: string; content?: string }> },
    })),
  };

  public constructor() {
    fakeRestClients.push(this);
  }
}

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

vi.mock('@thenvoi/rest-client', () => ({
  ThenvoiClient: FakeThenvoiClient,
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
  delete process.env.THENVOI_CONTACT_AGENT_GROUP_ID;
  delete process.env.THENVOI_INJECT_API_KEY;
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
    fakeRestClients.length = 0;
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
        metadata: { mentions: [{ id: 'agent-1' }] },
      },
    });

    await waitFor(() => fakeLinks[0].markProcessed.mock.calls.length === 1);
    expect(onInbound).toHaveBeenCalledWith(
      'thenvoi:room-1',
      null,
      expect.objectContaining({
        id: 'msg-1',
        content: expect.objectContaining({ text: 'hello' }),
        isMention: true,
      }),
    );
    expect(fakeLinks[0].markProcessing).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(fakeLinks[0].markProcessed).toHaveBeenCalledWith('room-1', 'msg-1');
    expect(
      getInboundDelivery({ channelType: 'thenvoi', platformId: 'thenvoi:room-1', platformMessageId: 'msg-1' })?.status,
    ).toBe('processed');
  });

  it('does not mark unmentioned Band room messages as mentions', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const result: InboundRouteResult = {
      status: 'dropped',
      platformMessageId: 'msg-unmentioned',
      reason: 'no_agent_engaged',
      audited: true,
      retryable: false,
      intentional: false,
    };
    const onInbound = vi.fn(async (_platformId: string, _threadId: string | null, _message: InboundMessage) => result);

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
        id: 'msg-unmentioned',
        content: 'room chatter',
        message_type: 'text',
        sender_id: 'user-1',
        sender_type: 'User',
        sender_name: 'User One',
        inserted_at: new Date().toISOString(),
        metadata: { mentions: [{ id: 'someone-else' }] },
      },
    });

    await waitFor(() => onInbound.mock.calls.length === 1);
    expect(onInbound.mock.calls[0][2]).toEqual(expect.objectContaining({ isMention: false }));
    expect(fakeLinks[0].markProcessing).not.toHaveBeenCalled();
    expect(fakeLinks[0].markProcessed).not.toHaveBeenCalled();
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
    expect(fakeRestClients[0].agentApiMessages.createAgentChatMessage).toHaveBeenCalledWith('room-1', {
      message: {
        content: 'hello from agent',
        mentions: [{ id: 'owner-1', name: 'Owner' }],
      },
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
        THENVOI_MEMORY_CONSOLIDATION: 'true',
      }),
    );
    expect(config.env).not.toHaveProperty('THENVOI_API_KEY');
  });

  it('injects direct Band API key for explicit live validation override', async () => {
    setThenvoiEnv();
    process.env.THENVOI_INJECT_API_KEY = 'true';
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

    expect(config.env).toHaveProperty('THENVOI_API_KEY', 'secret');
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

  it('marks discovered direct Band room as the main control room for container env', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
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

    const { getModuleState, getMessagingGroupByPlatform } = await import('../db/index.js');
    expect(getModuleState('thenvoi', 'main-room')).toMatchObject({ roomId: 'room-1', platformId: 'thenvoi:room-1' });

    const mg = getMessagingGroupByPlatform('thenvoi', 'thenvoi:room-1')!;
    const { getChannelContainerConfig } = await import('./channel-container-registry.js');
    const config = await getChannelContainerConfig('thenvoi')!({
      session: {
        id: 'sess-main',
        agent_group_id: 'ag-1',
        messaging_group_id: mg.id,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      messagingGroup: mg,
      agentGroupId: 'ag-1',
      hostEnv: process.env,
    });

    expect(config.env).toHaveProperty('THENVOI_IS_MAIN_CONTROL_ROOM', 'true');
  });

  it('closes active sessions when a Band room lifecycle event invalidates room privilege', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
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

    const { createAgentGroup, createSession, getMessagingGroupByPlatform, getSession } = await import('../db/index.js');
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent 1',
      folder: 'agent-1',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const mg = getMessagingGroupByPlatform('thenvoi', 'thenvoi:room-1')!;
    createSession({
      id: 'sess-room-1',
      agent_group_id: 'ag-1',
      messaging_group_id: mg.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    });

    fakeLinks[0].emit({ type: 'participant_removed', roomId: 'room-1', payload: { participant_id: 'agent-1' } });
    await waitFor(() => getSession('sess-room-1')?.status === 'closed');
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

  it('forwards THENVOI_OWNER_ID into the container env when set', async () => {
    setThenvoiEnv();
    process.env.THENVOI_OWNER_ID = 'owner-uuid-from-env';
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

    expect(config.env).toHaveProperty('THENVOI_OWNER_ID', 'owner-uuid-from-env');
    delete process.env.THENVOI_OWNER_ID;
  });

  it('rejects the removed callback contact strategy instead of auto-approving requests', async () => {
    setThenvoiEnv();
    process.env.THENVOI_CONTACT_STRATEGY = 'callback';
    await import('./thenvoi.js');
    const { getChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => undefined,
      onInboundEvent: async () => undefined,
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(getChannelAdapter('thenvoi')).toBeUndefined();
    expect(fakeRestClients).toHaveLength(0);
  });

  it('creates a hub room and routes contact events into it under hub_room strategy', async () => {
    setThenvoiEnv();
    process.env.THENVOI_CONTACT_STRATEGY = 'hub_room';
    process.env.THENVOI_CONTACT_AGENT_GROUP_ID = 'ag-contact';
    const { createAgentGroup } = await import('../db/index.js');
    createAgentGroup({
      id: 'ag-contact',
      name: 'Contact Agent',
      folder: 'contact-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    const onInbound = vi.fn(
      async (_platformId: string, _threadId: string | null) =>
        ({
          status: 'persisted',
          platformMessageId: 'unused',
          sessionIds: [],
          sessionMessageIds: [],
        }) satisfies InboundRouteResult,
    );

    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_request_received',
      roomId: null,
      payload: {
        id: 'req-hub-1',
        from_handle: 'jane',
        from_name: 'Jane Doe',
        status: 'pending',
        inserted_at: new Date().toISOString(),
      },
    });

    await waitFor(() => fakeRestClients[0].agentApiChats.createAgentChat.mock.calls.length === 1);
    await waitFor(() => fakeRestClients[0].agentApiParticipants.addAgentChatParticipant.mock.calls.length === 1);
    await waitFor(() => onInbound.mock.calls.some(([platformId]) => platformId === 'thenvoi:hub-room-1'));
    await waitFor(() => fakeRestClients[0].agentApiEvents.createAgentChatEvent.mock.calls.length === 1);

    expect(fakeRestClients[0].agentApiParticipants.addAgentChatParticipant).toHaveBeenCalledWith('hub-room-1', {
      participant: { participant_id: 'owner-1', role: 'member' },
    });

    const { getModuleState, getMessagingGroupByPlatform, getMessagingGroupAgentByPair } =
      await import('../db/index.js');
    expect(getModuleState('thenvoi', 'hub-room')).toMatchObject({ roomId: 'hub-room-1' });
    const mg = getMessagingGroupByPlatform('thenvoi', 'thenvoi:hub-room-1');
    expect(mg).toMatchObject({ name: 'Contact Hub', unknown_sender_policy: 'public' });
    expect(getMessagingGroupAgentByPair(mg!.id, 'ag-contact')).toMatchObject({
      agent_group_id: 'ag-contact',
      engage_mode: 'mention',
      session_mode: 'shared',
    });
  });

  it('reuses an existing hub room across contact events without recreating it', async () => {
    setThenvoiEnv();
    process.env.THENVOI_CONTACT_STRATEGY = 'hub_room';
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_added',
      roomId: null,
      payload: {
        id: 'contact-1',
        handle: 'jane',
        name: 'Jane Doe',
        type: 'human',
        inserted_at: new Date().toISOString(),
      },
    });
    fakeLinks[0].emit({
      type: 'contact_added',
      roomId: null,
      payload: {
        id: 'contact-2',
        handle: 'bob',
        name: 'Bob Roe',
        type: 'human',
        inserted_at: new Date().toISOString(),
      },
    });

    await waitFor(() => fakeRestClients[0].agentApiEvents.createAgentChatEvent.mock.calls.length === 2);
    expect(fakeRestClients[0].agentApiChats.createAgentChat).toHaveBeenCalledTimes(1);
  });

  it('drops contact events under disabled strategy without calling REST', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'contact_request_received',
      roomId: null,
      payload: {
        id: 'req-disabled',
        from_handle: 'jane',
        from_name: 'Jane Doe',
        status: 'pending',
        inserted_at: new Date().toISOString(),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeRestClients[0].agentApiContacts.respondToAgentContactRequest).not.toHaveBeenCalled();
    expect(fakeRestClients[0].agentApiChats.createAgentChat).not.toHaveBeenCalled();
  });

  it('injects participant memories on participant_added when memory load-on-start is enabled', async () => {
    setThenvoiEnv();
    process.env.THENVOI_MEMORY_LOAD_ON_START = 'true';
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    const onInbound = vi.fn(
      async (_platformId: string, _threadId: string | null, _message: unknown) =>
        ({
          status: 'persisted',
          platformMessageId: 'unused',
          sessionIds: [],
          sessionMessageIds: [],
        }) satisfies InboundRouteResult,
    );
    await initChannelAdapters(() => ({
      onInbound,
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeRestClients[0].agentApiMemories.listAgentMemories.mockResolvedValueOnce({
      data: {
        data: [
          { type: 'semantic', content: 'Prefers dark mode' },
          { type: 'episodic', content: 'Mentioned a deadline on 2026-04-01' },
        ],
      },
    });

    fakeLinks[0].emit({
      type: 'participant_added',
      roomId: 'room-1',
      payload: { id: 'user-42', name: 'Jane', type: 'User', handle: 'jane' },
    });

    await waitFor(() => fakeRestClients[0].agentApiMemories.listAgentMemories.mock.calls.length === 1);
    await waitFor(() => onInbound.mock.calls.some(([platformId]) => platformId === 'thenvoi:room-1'));

    expect(fakeRestClients[0].agentApiMemories.listAgentMemories).toHaveBeenCalledWith({
      subject_id: 'user-42',
      scope: 'subject',
    });
    const call = onInbound.mock.calls.find(([platformId]) => platformId === 'thenvoi:room-1')!;
    const message = call[2] as { content: { text: string; senderId: string } };
    expect(message.content.senderId).toBe('system');
    expect(message.content.text).toContain('Jane joined the room');
    expect(message.content.text).toContain('Prefers dark mode');
  });

  it('does not fetch participant memories when load-on-start is disabled', async () => {
    setThenvoiEnv();
    await import('./thenvoi.js');
    const { initChannelAdapters } = await import('./channel-registry.js');

    await initChannelAdapters(() => ({
      onInbound: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onInboundEvent: async () => ({
        status: 'persisted',
        platformMessageId: 'unused',
        sessionIds: [],
        sessionMessageIds: [],
      }),
      onMetadata: () => {},
      onAction: () => {},
    }));

    fakeLinks[0].emit({
      type: 'participant_added',
      roomId: 'room-1',
      payload: { id: 'user-42', name: 'Jane', type: 'User', handle: 'jane' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeRestClients[0].agentApiMemories.listAgentMemories).not.toHaveBeenCalled();
  });
});
