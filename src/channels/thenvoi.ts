import { ThenvoiLink, type PlatformEvent } from '@thenvoi/sdk';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundRouteResult, OutboundMessage } from './adapter.js';
import { registerChannelContainerConfig } from './channel-container-registry.js';
import { registerChannelAdapter } from './channel-registry.js';
import { markInboundDeliveryProcessed } from '../db/inbound-delivery-ledger.js';
import { log } from '../log.js';
import { getThenvoiConfig, type ThenvoiConfig } from '../modules/thenvoi-config.js';

export const THENVOI_CHANNEL_TYPE = 'thenvoi';
export const THENVOI_PLATFORM_PREFIX = 'thenvoi:';

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

class ThenvoiChannelAdapter implements ChannelAdapter {
  public readonly name = 'Band.ai';
  public readonly channelType = THENVOI_CHANNEL_TYPE;
  public readonly supportsThreads = false;

  private setupConfig: ChannelSetup | null = null;
  private connected = false;
  private stopController: AbortController | null = null;
  private eventLoop: Promise<void> | null = null;
  private readonly link: ThenvoiLink;

  public constructor(private readonly config: ThenvoiConfig) {
    const wsUrl = wsUrlFromBaseUrl(config.baseUrl);
    this.link = new ThenvoiLink({
      agentId: config.agentId,
      apiKey: config.apiKey,
      wsUrl,
      restUrl: restUrlFromWsUrl(wsUrl),
    });
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

  public async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const roomId = parseThenvoiPlatformId(platformId);
    if (message.kind !== 'chat') {
      return undefined;
    }

    const text = typeof message.content === 'string'
      ? message.content
      : typeof (message.content as { text?: unknown }).text === 'string'
        ? (message.content as { text: string }).text
        : JSON.stringify(message.content);

    const result = await this.link.rest.createChatMessage(roomId, {
      content: text,
      messageType: 'text',
      metadata: { source: 'nanoclaw_fallback' },
    });

    return typeof result.id === 'string' ? result.id : undefined;
  }

  public async syncConversations(): Promise<ConversationInfo[]> {
    const rooms = await this.link.listAllChats({ pageSize: 50 });
    const conversations: ConversationInfo[] = [];

    for (const room of rooms) {
      const roomId = typeof room.id === 'string' ? room.id : undefined;
      if (!roomId) continue;

      await this.link.subscribeRoom(roomId);
      const title = typeof room.title === 'string' ? room.title : undefined;
      const isGroup = room.type !== 'direct';
      const platformId = formatThenvoiPlatformId(roomId);
      conversations.push({ platformId, name: title ?? roomId, isGroup });
      this.setupConfig?.onMetadata(platformId, title, isGroup);
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

    for await (const event of this.link) {
      if (signal.aborted) return;
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: PlatformEvent): Promise<void> {
    switch (event.type) {
      case 'room_added':
        await this.handleRoomAdded(event.roomId, event.payload);
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
    const title = typeof payload.title === 'string' ? payload.title : undefined;
    const isGroup = payload.type !== 'direct';
    this.setupConfig?.onMetadata(formatThenvoiPlatformId(id), title, isGroup);
  }

  private async handleMessageCreated(roomId: string | null, payload: {
    id: string;
    content: string;
    message_type: string;
    sender_id: string;
    sender_type: string;
    sender_name?: string | null;
    chat_room_id?: string | null;
    inserted_at: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.setupConfig) return;
    if (payload.sender_id === this.config.agentId) return;
    if (payload.message_type !== 'text') return;

    const resolvedRoomId = roomId ?? payload.chat_room_id;
    if (!resolvedRoomId) return;

    const platformId = formatThenvoiPlatformId(resolvedRoomId);
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

registerChannelContainerConfig(THENVOI_CHANNEL_TYPE, ({ messagingGroup }) => {
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
  };

  if (shouldInjectDirectApiKey(config.baseUrl)) {
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
