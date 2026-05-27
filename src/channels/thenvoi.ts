import { ThenvoiLink, type PlatformEvent } from '@thenvoi/sdk';
import { ThenvoiClient } from '@thenvoi/rest-client';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundRouteResult, OutboundMessage } from './adapter.js';
import { registerChannelContainerConfig } from './channel-container-registry.js';
import { registerChannelAdapter } from './channel-registry.js';
import { getAllAgentGroups, getAgentGroup } from '../db/agent-groups.js';
import { markInboundDeliveryProcessed } from '../db/inbound-delivery-ledger.js';
import {
  getMessagingGroupByPlatform,
  createMessagingGroup,
  updateMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../db/messaging-groups.js';
import { closeActiveSessionsForMessagingGroup } from '../db/sessions.js';
import { getModuleState, setModuleState, deleteModuleState } from '../db/module-state.js';
import { log } from '../log.js';
import { getThenvoiConfig, type ThenvoiConfig } from '../modules/thenvoi-config.js';

export const THENVOI_CHANNEL_TYPE = 'thenvoi';
export const THENVOI_PLATFORM_PREFIX = 'thenvoi:';

const THENVOI_MODULE_NAME = 'thenvoi';
const MAIN_ROOM_STATE_KEY = 'main-room';
const MAIN_ROOM_NAME = 'Main Control Room';
const HUB_ROOM_STATE_KEY = 'hub-room';
const HUB_ROOM_NAME = 'Contact Hub';
const SYNTHETIC_CONTACT_SENDER_ID = 'contact-events';
const SYNTHETIC_CONTACT_SENDER_NAME = 'Contact Events';
const MAX_CONTACT_DEDUP = 1000;

interface ThenvoiMainRoomState {
  roomId: string;
  platformId: string;
  updatedAt: string;
}

interface ThenvoiHubRoomState {
  roomId: string;
  platformId: string;
  createdAt: string;
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

function mentionReferencesAgent(mention: unknown, agentId: string): boolean {
  if (typeof mention === 'string') return mention === agentId;
  if (!mention || typeof mention !== 'object') return false;
  const value = mention as Record<string, unknown>;
  return [value.id, value.uuid, value.agent_id, value.agentId, value.participant_id, value.participantId].some(
    (candidate) => candidate === agentId,
  );
}

function metadataMentionsAgent(metadata: Record<string, unknown> | null | undefined, agentId: string): boolean {
  const mentions = metadata?.mentions;
  return Array.isArray(mentions) && mentions.some((mention) => mentionReferencesAgent(mention, agentId));
}

function now(): string {
  return new Date().toISOString();
}

function safeRoomTitle(room: Record<string, unknown>, fallback: string): string {
  return typeof room.title === 'string' && room.title.length > 0 ? room.title : fallback;
}

function collectParticipantIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const participant = value as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ['id', 'uuid', 'user_id', 'userId', 'agent_id', 'agentId', 'participant_id', 'participantId']) {
    const candidate = participant[key];
    if (typeof candidate === 'string') ids.push(candidate);
  }
  for (const key of ['user', 'agent', 'participant']) {
    ids.push(...collectParticipantIds(participant[key]));
  }
  return ids;
}

function isOwnerAgentDirectRoom(room: Record<string, unknown>, config: ThenvoiConfig): boolean {
  if (room.is_main === true || room.isMain === true || room.main === true) return true;

  const participants = Array.isArray(room.participants) ? room.participants : [];
  if (participants.length !== 2 || !config.ownerId) return false;

  const participantIds = participants.map((participant) => new Set(collectParticipantIds(participant)));
  return (
    participantIds.some((ids) => ids.has(config.agentId)) &&
    participantIds.some((ids) => ids.has(config.ownerId as string))
  );
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

function getHubRoomState(): ThenvoiHubRoomState | undefined {
  return getModuleState<ThenvoiHubRoomState>(THENVOI_MODULE_NAME, HUB_ROOM_STATE_KEY);
}

function setHubRoom(roomId: string): void {
  setModuleState(THENVOI_MODULE_NAME, HUB_ROOM_STATE_KEY, {
    roomId,
    platformId: formatThenvoiPlatformId(roomId),
    createdAt: now(),
  } satisfies ThenvoiHubRoomState);
}

function ensureHubMessagingGroup(roomId: string, agentGroupId: string | null): void {
  const platformId = formatThenvoiPlatformId(roomId);
  let messagingGroupId: string;
  const existing = getMessagingGroupByPlatform(THENVOI_CHANNEL_TYPE, platformId);
  if (existing) {
    messagingGroupId = existing.id;
    if (existing.unknown_sender_policy !== 'public' || existing.name !== HUB_ROOM_NAME) {
      updateMessagingGroup(existing.id, {
        name: HUB_ROOM_NAME,
        is_group: 1,
        unknown_sender_policy: 'public',
      });
    }
  } else {
    messagingGroupId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: THENVOI_CHANNEL_TYPE,
      platform_id: platformId,
      name: HUB_ROOM_NAME,
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now(),
    });
  }

  if (!agentGroupId) return;
  if (getMessagingGroupAgentByPair(messagingGroupId, agentGroupId)) return;
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function upsertDiscoveredMessagingGroup(
  roomId: string,
  room: Record<string, unknown>,
  config: ThenvoiConfig,
  forceMain = false,
): void {
  const platformId = formatThenvoiPlatformId(roomId);
  const isMain = forceMain || isOwnerAgentDirectRoom(room, config);
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
  private hubRoomInitPromise: Promise<string | null> | null = null;
  private readonly contactDedup = new Set<string>();
  private readonly contactDedupOrder: string[] = [];

  public constructor(private readonly config: ThenvoiConfig) {
    const wsUrl = wsUrlFromBaseUrl(config.baseUrl);
    const restUrl = restUrlFromWsUrl(wsUrl);
    this.link = new ThenvoiLink({
      agentId: config.agentId,
      apiKey: config.apiKey,
      wsUrl,
      restUrl,
      capabilities: { contacts: config.contactStrategy !== 'disabled' },
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
      upsertDiscoveredMessagingGroup(roomId, roomRecord, this.config);
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
        await this.maybeInjectParticipantMemories(event.roomId, event.payload);
        break;
      case 'message_created':
        await this.handleMessageCreated(event.roomId, event.payload);
        break;
      case 'contact_request_received':
      case 'contact_request_updated':
      case 'contact_added':
      case 'contact_removed':
        await this.handleContactEvent(event);
        break;
      default:
        break;
    }
  }

  private async handleRoomAdded(roomId: string | null, payload: Record<string, unknown>): Promise<void> {
    const id = roomId ?? (typeof payload.id === 'string' ? payload.id : null);
    if (!id) return;
    await this.link.subscribeRoom(id);
    upsertDiscoveredMessagingGroup(id, payload, this.config);
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

    // participant_added payloads describe only the participant that joined, not the
    // full room. Do not upsert room metadata from that partial shape.
    if (getMainRoomState()?.roomId === id) {
      clearMainRoomIfMatches(id);
      closeSessionsForRoom(id, 'main_room_participant_added');
    }
  }

  /**
   * When a new participant joins a Band room, fetch up to 10 of their stored
   * memories and inject them into the room as a synthetic system message so
   * the next agent turn has context. No-op unless `THENVOI_MEMORY_LOAD_ON_START`
   * is enabled and the room is wired (i.e. has a messaging_group row).
   *
   * Failure is non-fatal — the room still functions without preloaded memory.
   */
  private async maybeInjectParticipantMemories(roomId: string | null, payload: Record<string, unknown>): Promise<void> {
    if (!this.config.memoryLoadOnStart || !this.setupConfig) return;
    const resolvedRoomId = roomId ?? (typeof payload.chat_room_id === 'string' ? payload.chat_room_id : null);
    if (!resolvedRoomId) return;

    const platformId = formatThenvoiPlatformId(resolvedRoomId);
    if (!getMessagingGroupByPlatform(THENVOI_CHANNEL_TYPE, platformId)) return;

    const participantId = typeof payload.id === 'string' ? payload.id : null;
    const participantName = typeof payload.name === 'string' ? payload.name : 'Someone';
    if (!participantId) return;

    try {
      const response = await this.restClient.agentApiMemories.listAgentMemories({
        subject_id: participantId,
        scope: 'subject',
      });
      const data = (response as { data?: { data?: Array<{ type?: string; content?: string }> } }).data;
      const items = (data?.data ?? []).slice(0, 10);
      if (items.length === 0) return;

      const memoryLines = items.map((m) => `- [${m.type ?? 'memory'}] ${m.content ?? ''}`).join('\n');
      const text = `[System]: ${participantName} joined the room. Here's what you know about them:\n${memoryLines}`;

      const syntheticId = `participant-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const messageContent: ThenvoiMessageContent = {
        text,
        sender: 'system',
        senderId: 'system',
        senderName: 'System',
        senderType: 'System',
        roomId: resolvedRoomId,
        metadata: { participantJoinedId: participantId, participantJoinedName: participantName },
      };

      await this.setupConfig.onInbound(platformId, null, {
        id: syntheticId,
        kind: 'chat',
        content: messageContent,
        timestamp: now(),
        isMention: true,
        isGroup: true,
      });
      log.info('Band.ai injected participant memories', {
        roomId: resolvedRoomId,
        participantId,
        memoryCount: items.length,
      });
    } catch (err) {
      log.warn('Band.ai failed to inject participant memories', {
        err,
        roomId: resolvedRoomId,
        participantId,
      });
    }
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
      this.config,
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
      isMention: metadataMentionsAgent(payload.metadata, this.config.agentId),
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

  private dedupContactEvent(event: PlatformEvent): boolean {
    const payload = event.payload as { id?: unknown; status?: unknown } | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : 'unknown';
    const status = typeof payload?.status === 'string' ? `:${payload.status}` : '';
    const key = `${event.type}:${id}${status}`;
    if (this.contactDedup.has(key)) return false;
    this.contactDedup.add(key);
    this.contactDedupOrder.push(key);
    while (this.contactDedup.size > MAX_CONTACT_DEDUP) {
      const oldest = this.contactDedupOrder.shift();
      if (oldest) this.contactDedup.delete(oldest);
    }
    return true;
  }

  private async handleContactEvent(event: PlatformEvent): Promise<void> {
    if (
      event.type !== 'contact_request_received' &&
      event.type !== 'contact_request_updated' &&
      event.type !== 'contact_added' &&
      event.type !== 'contact_removed'
    ) {
      return;
    }
    if (!this.dedupContactEvent(event)) return;

    const strategy = this.config.contactStrategy;
    if (strategy === 'disabled') return;

    if (strategy === 'hub_room') {
      await this.handleContactHubRoom(event);
    }
  }

  private async handleContactHubRoom(event: PlatformEvent): Promise<void> {
    if (!this.setupConfig) return;
    const roomId = await this.ensureHubRoom();
    if (!roomId) {
      log.warn('Band.ai hub room unavailable; dropping contact event', { type: event.type });
      return;
    }
    const platformId = formatThenvoiPlatformId(roomId);
    const content = formatContactEvent(event);

    const syntheticId = `contact-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messageContent: ThenvoiMessageContent = {
      text: content,
      sender: SYNTHETIC_CONTACT_SENDER_ID,
      senderId: SYNTHETIC_CONTACT_SENDER_ID,
      senderName: SYNTHETIC_CONTACT_SENDER_NAME,
      senderType: 'System',
      roomId,
      metadata: { contactEventType: event.type, contactPayload: event.payload },
    };

    try {
      await this.setupConfig.onInbound(platformId, null, {
        id: syntheticId,
        kind: 'chat',
        content: messageContent,
        timestamp: now(),
        isMention: true,
        isGroup: true,
      });
    } catch (err) {
      log.warn('Band.ai failed to inject contact event into hub room', { err, type: event.type });
    }

    try {
      await this.restClient.agentApiEvents.createAgentChatEvent(roomId, {
        event: {
          content,
          message_type: 'task',
          metadata: { contactEventType: event.type },
        },
      });
    } catch (err) {
      log.warn('Band.ai failed to persist contact event to platform', { err, roomId });
    }
  }

  private resolveHubAgentGroupId(): string | null {
    if (this.config.contactAgentGroupId) {
      if (getAgentGroup(this.config.contactAgentGroupId)) return this.config.contactAgentGroupId;
      log.warn('Band.ai contact hub agent group not found; hub messages will not wake an agent', {
        agentGroupId: this.config.contactAgentGroupId,
      });
      return null;
    }

    const agentGroups = getAllAgentGroups();
    if (agentGroups.length === 1) return agentGroups[0].id;
    log.warn('Band.ai contact hub has no unambiguous agent group; set THENVOI_CONTACT_AGENT_GROUP_ID', {
      agentGroupCount: agentGroups.length,
    });
    return null;
  }

  private async ensureHubRoom(): Promise<string | null> {
    const persisted = getHubRoomState();
    if (persisted) {
      ensureHubMessagingGroup(persisted.roomId, this.resolveHubAgentGroupId());
      return persisted.roomId;
    }
    if (this.hubRoomInitPromise) return this.hubRoomInitPromise;

    this.hubRoomInitPromise = (async () => {
      try {
        const response = await this.restClient.agentApiChats.createAgentChat({ chat: {} });
        const data = (response as { data?: { id?: unknown } }).data;
        const newRoomId = typeof data?.id === 'string' ? data.id : null;
        if (!newRoomId) {
          log.warn('Band.ai hub room creation returned no id');
          return null;
        }

        const ownerId = await this.resolveOwnerId();
        if (ownerId) {
          try {
            await this.restClient.agentApiParticipants.addAgentChatParticipant(newRoomId, {
              participant: { participant_id: ownerId, role: 'member' },
            });
          } catch (err) {
            log.warn('Band.ai failed to add owner to hub room', { err, ownerId, roomId: newRoomId });
          }
        } else {
          log.warn('Band.ai hub room created without owner; owner will not see it');
        }

        setHubRoom(newRoomId);
        ensureHubMessagingGroup(newRoomId, this.resolveHubAgentGroupId());
        try {
          await this.link.subscribeRoom(newRoomId);
        } catch (err) {
          log.warn('Band.ai failed to subscribe to new hub room', { err, roomId: newRoomId });
        }
        log.info('Band.ai contact hub room created', { roomId: newRoomId });
        return newRoomId;
      } catch (err) {
        log.error('Band.ai failed to create hub room', { err });
        return null;
      }
    })();

    try {
      return await this.hubRoomInitPromise;
    } finally {
      this.hubRoomInitPromise = null;
    }
  }

  private async resolveOwnerId(): Promise<string | null> {
    if (this.config.ownerId) return this.config.ownerId;
    try {
      const response = await this.restClient.agentApiIdentity.getAgentMe();
      const data = (response as { data?: { owner_uuid?: unknown; ownerUuid?: unknown } }).data;
      if (typeof data?.owner_uuid === 'string') return data.owner_uuid;
      if (typeof data?.ownerUuid === 'string') return data.ownerUuid;
    } catch (err) {
      log.warn('Band.ai failed to resolve owner UUID', { err });
    }
    return null;
  }
}

function formatContactEvent(event: PlatformEvent): string {
  switch (event.type) {
    case 'contact_request_received': {
      const p = event.payload as { id: string; from_name: string; from_handle: string; message?: string | null };
      const msg = p.message ? `\nMessage: "${p.message}"` : '';
      return `[Contact Request] ${p.from_name} (@${p.from_handle}) wants to connect.${msg}\nRequest ID: ${p.id}`;
    }
    case 'contact_request_updated': {
      const p = event.payload as { id: string; status: string };
      return `[Contact Update] Request ${p.id} status changed to: ${p.status}`;
    }
    case 'contact_added': {
      const p = event.payload as { id: string; name: string; handle: string; type: string };
      return `[Contact Added] ${p.name} (@${p.handle}), type: ${p.type}. ID: ${p.id}`;
    }
    case 'contact_removed': {
      const p = event.payload as { id: string };
      return `[Contact Removed] Contact ${p.id} was removed.`;
    }
    default:
      return `[Contact Event] ${(event as { type: string }).type}`;
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
    THENVOI_MEMORY_CONSOLIDATION: String(config.memoryConsolidation),
    THENVOI_CONTACT_STRATEGY: config.contactStrategy,
    THENVOI_IS_MAIN_CONTROL_ROOM: String(isMainRoomPlatformId(messagingGroup.platform_id)),
  };

  if (config.ownerId) {
    env.THENVOI_OWNER_ID = config.ownerId;
  }

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
