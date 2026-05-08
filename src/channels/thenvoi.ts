import { ThenvoiLink, type PlatformEvent } from '@thenvoi/sdk';
import { ThenvoiClient } from '@thenvoi/rest-client';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundRouteResult, OutboundMessage } from './adapter.js';
import { registerChannelContainerConfig } from './channel-container-registry.js';
import { registerChannelAdapter } from './channel-registry.js';
import { markInboundDeliveryProcessed } from '../db/inbound-delivery-ledger.js';
import { getMessagingGroupByPlatform, createMessagingGroup, updateMessagingGroup } from '../db/messaging-groups.js';
import { closeActiveSessionsForMessagingGroup } from '../db/sessions.js';
import { getModuleState, setModuleState, deleteModuleState } from '../db/module-state.js';
import { log } from '../log.js';
import { getThenvoiConfig, type ThenvoiConfig } from '../modules/thenvoi-config.js';

export const THENVOI_CHANNEL_TYPE = 'thenvoi';
export const THENVOI_PLATFORM_PREFIX = 'thenvoi:';

const THENVOI_MODULE_NAME = 'thenvoi';
const MAIN_ROOM_STATE_KEY = 'main-room';
const MAIN_ROOM_NAME = 'Main Control Room';

interface ThenvoiMainRoomState {
  roomId: string;
  platformId: string;
  updatedAt: string;
}

interface ThenvoiMessageContent {
  text: string;
  sender: string;
  senderId: string;
  senderName: string | null;
  senderType: string;
  roomId: string;
  metadata?: Record<string, unknown>;
}

export function formatThenvoiPlatformId(roomId: string): string {
  return roomId.startsWith(THENVOI_PLATFORM_PREFIX) ? roomId : `${THENVOI_PLATFORM_PREFIX}${roomId}`;
}

export function parseThenvoiPlatformId(platformId: string): string {
  if (!platformId.startsWith(THENVOI_PLATFORM_PREFIX)) {
    throw new Error(`Invalid Thenvoi platform id: ${platformId}`);
  }
  return platformId.slice(THENVOI_PLATFORM_PREFIX.length);
}

function wsUrlFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/v1/socket';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function restUrlFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  return `${url.protocol}//${url.host}`;
}

function containerReachableRestUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.hostname = 'host.docker.internal';
  }
  return url.toString().replace(/\/$/, '');
}

function shouldInjectDirectApiKey(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function isProcessableRouteResult(result: void | InboundRouteResult): result is InboundRouteResult {
  return result?.status === 'persisted' || (result?.status === 'dropped' && result.intentional);
}

function now(): string {
  return new Date().toISOString();
}

function safeRoomTitle(room: Record<string, unknown>, fallback: string): string {
  return typeof room.title === 'string' && room.title.length > 0 ? room.title : fallback;
}

function isOwnerDirectRoom(room: Record<string, unknown>): boolean {
  if (room.is_main === true || room.isMain === true || room.main === true) return true;
  if (room.type === 'direct' || room.kind === 'direct' || room.room_type === 'direct') return true;

  const participants = Array.isArray(room.participants) ? room.participants : [];
  if (participants.length !== 2) return false;
  const ids = participants.flatMap((participant) => {
    if (!participant || typeof participant !== 'object') return [];
    const value = participant as Record<string, unknown>;
    return typeof value.id === 'string' ? [value.id] : typeof value.uuid === 'string' ? [value.uuid] : [];
  });
  return ids.length === 2;
}

function getMainRoomState(): ThenvoiMainRoomState | undefined {
  return getModuleState<ThenvoiMainRoomState>(THENVOI_MODULE_NAME, MAIN_ROOM_STATE_KEY);
}

function setMainRoom(roomId: string): void {
  setModuleState(THENVOI_MODULE_NAME, MAIN_ROOM_STATE_KEY, {
    roomId,
    platformId: formatThenvoiPlatformId(roomId),
    updatedAt: now(),
  } satisfies ThenvoiMainRoomState);
}

function isMainRoomPlatformId(platformId: string): boolean {
  return getMainRoomState()?.platformId === platformId;
}

function upsertDiscoveredMessagingGroup(roomId: string, room: Record<string, unknown>, forceMain = false): void {
  const platformId = formatThenvoiPlatformId(roomId);
  const isMain = forceMain || isOwnerDirectRoom(room);
  const name = isMain ? MAIN_ROOM_NAME : safeRoomTitle(room, roomId);
  const isGroup = isMain ? 0 : room.type === 'direct' ? 0 : 1;
  const existing = getMessagingGroupByPlatform(THENVOI_CHANNEL_TYPE, platformId);

  if (!existing) {
    createMessagingGroup({
      id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel_type: THENVOI_CHANNEL_TYPE,
      platform_id: platformId,
      name,
      is_group: isGroup,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: now(),
    });
  } else {
    updateMessagingGroup(existing.id, { name, is_group: isGroup });
  }

  if (isMain) setMainRoom(roomId);
}

function closeSessionsForRoom(roomId: string, reason: string): void {
  const mg = getMessagingGroupByPlatform(THENVOI_CHANNEL_TYPE, formatThenvoiPlatformId(roomId));
  if (!mg) return;
  const closed = closeActiveSessionsForMessagingGroup(mg.id);
  if (closed > 0) log.info('Band.ai closed stale room sessions', { roomId, reason, closed });
}

function clearMainRoomIfMatches(roomId: string): void {
  if (getMainRoomState()?.roomId === roomId) deleteModuleState(THENVOI_MODULE_NAME, MAIN_ROOM_STATE_KEY);
}

class ThenvoiChannelAdapter implements ChannelAdapter {
  public readonly name = 'Band.ai';
  public readonly channelType = THENVOI_CHANNEL_TYPE;
  public readonly supportsThreads = false;

  private setupConfig: ChannelSetup | null = null;
  private connected = false;
  private stopController: AbortController | null = null;
  private eventLoop: Promise<void> | null = null;
  private readonly link: ThenvoiLink;
  private readonly restClient: ThenvoiClient;
  private ownerMention: { id: string; name?: string } | null = null;

  public constructor(private readonly config: ThenvoiConfig) {
    const wsUrl = wsUrlFromBaseUrl(config.baseUrl);
    const restUrl = restUrlFromWsUrl(wsUrl);
    this.link = new ThenvoiLink({
      agentId: config.agentId,
      apiKey: config.apiKey,
      wsUrl,
      restUrl,
    });
    this.restClient = new ThenvoiClient({ apiKey: config.apiKey, baseUrl: restUrl });
  }

  public async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    this.stopController = new AbortController();

    await this.link.connect();
    await this.link.subscribeAgentRooms();
    await this.syncConversations();

    this.connected = true;
    this.eventLoop = this.runEventLoop(this.stopController.signal);
  }

  public async teardown(): Promise<void> {
    this.stopController?.abort();
    try {
      await this.eventLoop;
    } catch (err) {
      log.warn('Band.ai event loop stopped with error', { err });
    }
    await this.link.disconnect();
    this.connected = false;
    this.setupConfig = null;
    this.stopController = null;
    this.eventLoop = null;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
    const roomId = parseThenvoiPlatformId(platformId);
    if (message.kind !== 'chat') {
      return undefined;
    }

    const text =
      typeof message.content === 'string'
        ? message.content
        : typeof (message.content as { text?: unknown }).text === 'string'
          ? (message.content as { text: string }).text
          : JSON.stringify(message.content);

    const mention = await this.getOwnerMention();
    const result = await this.restClient.agentApiMessages.createAgentChatMessage(roomId, {
      message: {
        content: text,
        mentions: [mention],
      },
    });

    const data = (result as { data?: { id?: unknown } }).data;
    return typeof data?.id === 'string' ? data.id : undefined;
  }

  private async getOwnerMention(): Promise<{ id: string; name?: string }> {
    if (this.ownerMention) return this.ownerMention;
    const response = await this.restClient.agentApiIdentity.getAgentMe();
    const data = (response as { data?: { owner_uuid?: unknown; ownerUuid?: unknown } }).data;
    const ownerId =
      typeof data?.owner_uuid === 'string'
        ? data.owner_uuid
        : typeof data?.ownerUuid === 'string'
          ? data.ownerUuid
          : null;
    if (!ownerId) throw new Error('Band.ai owner identity unavailable for fallback delivery');
    this.ownerMention = { id: ownerId, name: 'Owner' };
    return this.ownerMention;
  }

  public async syncConversations(): Promise<ConversationInfo[]> {
    const rooms = await this.link.listAllChats({ pageSize: 50 });
    const conversations: ConversationInfo[] = [];

    const seenRoomIds = new Set<string>();
    for (const room of rooms) {
      const roomRecord = room as Record<string, unknown>;
      const roomId = typeof roomRecord.id === 'string' ? roomRecord.id : undefined;
      if (!roomId) continue;
      seenRoomIds.add(roomId);

      await this.link.subscribeRoom(roomId);
      upsertDiscoveredMessagingGroup(roomId, roomRecord);
      const main = getMainRoomState()?.roomId === roomId;
      const title = main ? MAIN_ROOM_NAME : typeof roomRecord.title === 'string' ? roomRecord.title : undefined;
      const isGroup = main ? false : roomRecord.type !== 'direct';
      const platformId = formatThenvoiPlatformId(roomId);
      conversations.push({ platformId, name: title ?? roomId, isGroup });
      this.setupConfig?.onMetadata(platformId, title, isGroup);
    }

    const state = getMainRoomState();
    if (state && !seenRoomIds.has(state.roomId)) {
      clearMainRoomIfMatches(state.roomId);
      closeSessionsForRoom(state.roomId, 'main_room_missing_during_sync');
    }

    return conversations;
  }

  public get agentId(): string {
    return this.config.agentId;
  }

  private async runEventLoop(signal: AbortSignal): Promise<void> {
    void this.link.runForever(signal).catch((err) => {
      if (!signal.aborted) log.warn('Band.ai websocket loop stopped', { err });
    });

    const iterator = this.link[Symbol.asyncIterator]();
    while (!signal.aborted) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<PlatformEvent>>((resolve) => {
          signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
        }),
      ]);
      if (next.done || signal.aborted) return;
      await this.handleEvent(next.value);
    }
  }

  private async handleEvent(event: PlatformEvent): Promise<void> {
    switch (event.type) {
      case 'room_added':
        await this.handleRoomAdded(event.roomId, event.payload);
        break;
      case 'room_removed':
      case 'room_deleted':
      case 'participant_removed':
        this.handleRoomInvalidated(event.roomId, event.payload, event.type);
        break;
      case 'participant_added':
        this.handleParticipantAdded(event.roomId, event.payload);
        break;
      case 'message_created':
        await this.handleMessageCreated(event.roomId, event.payload);
        break;
      default:
        break;
    }
  }

  private async handleRoomAdded(roomId: string | null, payload: Record<string, unknown>): Promise<void> {
    const id = roomId ?? (typeof payload.id === 'string' ? payload.id : null);
    if (!id) return;
    await this.link.subscribeRoom(id);
    upsertDiscoveredMessagingGroup(id, payload);
    const main = getMainRoomState()?.roomId === id;
    const title = main ? MAIN_ROOM_NAME : typeof payload.title === 'string' ? payload.title : undefined;
    const isGroup = main ? false : payload.type !== 'direct';
    this.setupConfig?.onMetadata(formatThenvoiPlatformId(id), title, isGroup);
  }

  private handleRoomInvalidated(roomId: string | null, payload: Record<string, unknown>, reason: string): void {
    const id =
      roomId ??
      (typeof payload.id === 'string'
        ? payload.id
        : typeof payload.chat_room_id === 'string'
          ? payload.chat_room_id
          : null);
    if (!id) return;
    closeSessionsForRoom(id, reason);
    clearMainRoomIfMatches(id);
  }

  private handleParticipantAdded(roomId: string | null, payload: Record<string, unknown>): void {
    const id = roomId ?? (typeof payload.chat_room_id === 'string' ? payload.chat_room_id : null);
    if (!id) return;
    const before = getMainRoomState()?.roomId === id;
    upsertDiscoveredMessagingGroup(id, payload);
    const after = getMainRoomState()?.roomId === id;
    if (before !== after) closeSessionsForRoom(id, 'main_room_privilege_changed');
  }

  private async handleMessageCreated(
    roomId: string | null,
    payload: {
      id: string;
      content: string;
      message_type: string;
      sender_id: string;
      sender_type: string;
      sender_name?: string | null;
      chat_room_id?: string | null;
      inserted_at: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    if (!this.setupConfig) return;
    if (payload.sender_id === this.config.agentId) return;
    if (payload.message_type !== 'text') return;

    const resolvedRoomId = roomId ?? payload.chat_room_id;
    if (!resolvedRoomId) return;

    const platformId = formatThenvoiPlatformId(resolvedRoomId);
    upsertDiscoveredMessagingGroup(
      resolvedRoomId,
      { id: resolvedRoomId, title: resolvedRoomId, type: 'group' },
      getMainRoomState()?.roomId === resolvedRoomId,
    );
    const content: ThenvoiMessageContent = {
      text: payload.content,
      sender: payload.sender_id,
      senderId: payload.sender_id,
      senderName: payload.sender_name ?? null,
      senderType: payload.sender_type,
      roomId: resolvedRoomId,
      metadata: payload.metadata ?? undefined,
    };

    const result = await this.setupConfig.onInbound(platformId, null, {
      id: payload.id,
      kind: 'chat',
      content,
      timestamp: payload.inserted_at,
      isMention: true,
    });

    if (!isProcessableRouteResult(result)) return;

    try {
      await this.link.markProcessing(resolvedRoomId, payload.id);
      await this.link.markProcessed(resolvedRoomId, payload.id);
      markInboundDeliveryProcessed({
        channelType: THENVOI_CHANNEL_TYPE,
        platformId,
        platformMessageId: payload.id,
      });
    } catch (err) {
      log.warn('Band.ai failed to mark message processed', { roomId: resolvedRoomId, messageId: payload.id, err });
    }
  }
}

registerChannelContainerConfig(THENVOI_CHANNEL_TYPE, ({ messagingGroup, hostEnv }) => {
  const config = getThenvoiConfig();
  if (!config || !messagingGroup) return {};

  const env: Record<string, string> = {
    NANOCLAW_CHANNEL: THENVOI_CHANNEL_TYPE,
    THENVOI_ROOM_ID: parseThenvoiPlatformId(messagingGroup.platform_id),
    THENVOI_AGENT_ID: config.agentId,
    THENVOI_REST_URL: containerReachableRestUrl(config.baseUrl),
    THENVOI_MEMORY_TOOLS: String(config.memoryTools),
    THENVOI_MEMORY_LOAD_ON_START: String(config.memoryLoadOnStart),
    THENVOI_MEMORY_CONSOLIDATION: 'false',
    THENVOI_CONTACT_STRATEGY: config.contactStrategy,
    THENVOI_IS_MAIN_CONTROL_ROOM: String(isMainRoomPlatformId(messagingGroup.platform_id)),
  };

  if (shouldInjectDirectApiKey(config.baseUrl) || hostEnv.THENVOI_INJECT_API_KEY === 'true') {
    env.THENVOI_API_KEY = config.apiKey;
  }

  return { env };
});

registerChannelAdapter('thenvoi', {
  factory: () => {
    const config = getThenvoiConfig();
    if (!config) return null;
    return new ThenvoiChannelAdapter(config);
  },
});
