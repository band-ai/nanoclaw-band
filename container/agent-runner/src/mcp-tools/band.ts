import { ThenvoiLink } from '@band-ai/sdk';
import { AgentTools } from '@band-ai/sdk/runtime';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolsProtocol } from '@band-ai/sdk';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BAND_TOOL_REGISTRY = [
  { sdkName: 'thenvoi_send_message', bandName: 'band_send_message' },
  { sdkName: 'thenvoi_send_event', bandName: 'band_send_event' },
  { sdkName: 'thenvoi_get_participants', bandName: 'band_get_participants' },
  { sdkName: 'thenvoi_add_participant', bandName: 'band_add_participant' },
  { sdkName: 'thenvoi_remove_participant', bandName: 'band_remove_participant' },
  { sdkName: 'thenvoi_lookup_peers', bandName: 'band_lookup_peers' },
  { sdkName: 'thenvoi_create_chatroom', bandName: 'band_create_chatroom' },
  { sdkName: 'thenvoi_list_contacts', bandName: 'band_list_contacts' },
  { sdkName: 'thenvoi_add_contact', bandName: 'band_add_contact' },
  { sdkName: 'thenvoi_remove_contact', bandName: 'band_remove_contact' },
  { sdkName: 'thenvoi_list_contact_requests', bandName: 'band_list_contact_requests' },
  { sdkName: 'thenvoi_respond_contact_request', bandName: 'band_respond_contact_request' },
  { sdkName: 'thenvoi_list_memories', bandName: 'band_list_memories' },
  { sdkName: 'thenvoi_store_memory', bandName: 'band_store_memory' },
  { sdkName: 'thenvoi_get_memory', bandName: 'band_get_memory' },
  { sdkName: 'thenvoi_supersede_memory', bandName: 'band_supersede_memory' },
  { sdkName: 'thenvoi_archive_memory', bandName: 'band_archive_memory' },
] as const;

type BandToolRegistryEntry = (typeof BAND_TOOL_REGISTRY)[number];
type SdkToolName = BandToolRegistryEntry['sdkName'];

const BAND_TOOL_BY_SDK_NAME = new Map<string, BandToolRegistryEntry>(
  BAND_TOOL_REGISTRY.map((entry) => [entry.sdkName, entry]),
);
const BAND_TOOL_BY_MCP_NAME = new Map<string, BandToolRegistryEntry>(
  BAND_TOOL_REGISTRY.map((entry) => [entry.bandName, entry]),
);

const MUTATION_TOOLS_BLOCKED_IN_MAIN_ROOM = new Set<SdkToolName>([
  'thenvoi_add_participant',
  'thenvoi_remove_participant',
  'thenvoi_create_chatroom',
]);

// Tools that operate on a specific room. The SDK binds these to the AgentTools
// construction roomId, so to target an arbitrary room (e.g. from a Telegram
// session with no current room) the handler builds a per-room AgentTools and
// the MCP schema gains an optional `chat_room_id`. Room-independent tools
// (create_chatroom, lookup_peers, contacts, memory) are unaffected.
const ROOM_SCOPED_TOOLS = new Set<SdkToolName>([
  'thenvoi_send_message',
  'thenvoi_send_event',
  'thenvoi_get_participants',
  'thenvoi_add_participant',
  'thenvoi_remove_participant',
]);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

// BAND_* is canonical post-rename; THENVOI_* is honored as a legacy fallback
// so containers spawned by an older host keep working.
function bandEnv(suffix: string): string | undefined {
  return env(`BAND_${suffix}`) ?? env(`THENVOI_${suffix}`);
}

// The Band toolset is available whenever the agent identity is present —
// either in a Band room session (BAND_ROOM_ID set) or an agent-scoped session
// of a Band-wired group (BAND_AGENT_CONTROL=true, no room). Room-scoped tools
// then require an explicit chat_room_id when there is no current room.
function bandAgentToolsEnabled(): boolean {
  return Boolean(bandEnv('AGENT_ID') && bandEnv('REST_URL'));
}

/** The session's Band room, if this session is bound to one. */
function sessionRoomId(): string | undefined {
  return bandEnv('ROOM_ID');
}

function mainControlRoom(): boolean {
  return bandEnv('IS_MAIN_CONTROL_ROOM') === 'true';
}

function memoryToolsEnabled(): boolean {
  return bandEnv('MEMORY_TOOLS') === 'true' && !memoryDisabledForRun;
}

function consolidationMode(): boolean {
  return env('NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE') === 'true';
}

function isMemoryTool(sdkToolName: SdkToolName): boolean {
  return sdkToolName.includes('memory') || sdkToolName.includes('memories');
}

// AgentTools binds room-scoped operations to its construction roomId, so we
// cache one instance per target room. Room-independent tools use the base
// instance (its roomId is irrelevant to them).
const toolsByRoom = new Map<string, AgentToolsProtocol>();
let memoryDisabledForRun = false;

// Placeholder room for the base instance when the session has no current room
// (agent-scoped sessions). Room-independent tools never read it.
const AGENT_SCOPED_PLACEHOLDER_ROOM = 'agent-control';

function apiKey(): string {
  return bandEnv('API_KEY') ?? env('ONECLI_API_KEY') ?? '';
}

function restUrl(): string | undefined {
  return bandEnv('REST_URL');
}

function sdkToolsForRoom(targetRoomId: string): AgentToolsProtocol {
  const cached = toolsByRoom.get(targetRoomId);
  if (cached) return cached;

  const link = new ThenvoiLink({
    agentId: bandEnv('AGENT_ID')!,
    apiKey: apiKey(),
    restUrl: restUrl(),
  });
  const tools = new AgentTools({
    roomId: targetRoomId,
    rest: link.rest,
    capabilities: {
      peers: true,
      contacts: true,
      memory: memoryToolsEnabled(),
    },
  }).getAdapterTools();
  toolsByRoom.set(targetRoomId, tools);
  return tools;
}

/** Base toolset for schema generation and room-independent tool calls. */
function baseTools(): AgentToolsProtocol {
  return sdkToolsForRoom(sessionRoomId() ?? AGENT_SCOPED_PLACEHOLDER_ROOM);
}

function toBandToolName(sdkToolName: SdkToolName): string {
  return BAND_TOOL_BY_SDK_NAME.get(sdkToolName)!.bandName;
}

function toSdkToolName(bandToolName: string): SdkToolName | null {
  return BAND_TOOL_BY_MCP_NAME.get(bandToolName)?.sdkName ?? null;
}

function formatToolResult(result: unknown): CallToolResult {
  if (isSdkToolError(result)) {
    return {
      content: [{ type: 'text', text: result.legacyMessage ?? result.message ?? JSON.stringify(result) }],
      isError: true,
    };
  }

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function isSdkToolError(value: unknown): value is { message?: string; legacyMessage?: string; errorType?: string } {
  return Boolean(value && typeof value === 'object' && 'errorType' in value);
}

function isUnavailableMemoryResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as { status?: unknown; errorType?: unknown; message?: unknown; legacyMessage?: unknown };
  const haystack = [result.status, result.errorType, result.message, result.legacyMessage]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes('404') || haystack.includes('not found') || haystack.includes('unsupported');
}

function memoryDisabledResult(toolName: SdkToolName): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(toolName)} is disabled because the Band.ai memory API is unavailable for this run.`,
      },
    ],
    isError: true,
  };
}

function blockedDuringConsolidation(sdkToolName: SdkToolName): CallToolResult | null {
  if (!consolidationMode() || isMemoryTool(sdkToolName)) return null;
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(sdkToolName)} is blocked during Band.ai memory consolidation. Only memory tools are available in this mode.`,
      },
    ],
    isError: true,
  };
}

function blockedInMainRoom(sdkToolName: SdkToolName, hasExplicitRoom: boolean): CallToolResult | null {
  // Only guard the implicit current room: when the agent explicitly targets a
  // different room (chat_room_id), the main-control-room restriction doesn't apply.
  if (hasExplicitRoom) return null;
  if (!mainControlRoom() || !MUTATION_TOOLS_BLOCKED_IN_MAIN_ROOM.has(sdkToolName)) return null;
  return {
    content: [
      {
        type: 'text',
        text: `${toBandToolName(sdkToolName)} is blocked in the Band.ai main control room. Use a regular Band room for participant or room mutations.`,
      },
    ],
    isError: true,
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function normalizeDescription(description: unknown, registryEntry: BandToolRegistryEntry): string {
  const text = typeof description === 'string' ? description : 'Band.ai platform tool.';
  return text.replace(/Thenvoi/g, 'Band.ai').replaceAll(registryEntry.sdkName, registryEntry.bandName);
}

function sdkSchemaToMcpTool(schema: Record<string, unknown>): Tool | null {
  const sdkName = typeof schema.name === 'string' ? schema.name : undefined;
  const registryEntry = sdkName ? BAND_TOOL_BY_SDK_NAME.get(sdkName) : undefined;
  const inputSchema = schema.input_schema && typeof schema.input_schema === 'object' ? schema.input_schema : undefined;
  if (!registryEntry || !inputSchema) return null;

  let finalSchema = inputSchema as Record<string, unknown>;
  if (ROOM_SCOPED_TOOLS.has(registryEntry.sdkName)) {
    const properties = { ...((finalSchema.properties as Record<string, unknown> | undefined) ?? {}) };
    properties.chat_room_id = {
      type: 'string',
      description:
        'Target Band room id. Optional in a Band room session (defaults to the current room); required when this tool is used from another channel (e.g. Telegram).',
    };
    finalSchema = { ...finalSchema, properties };
  }

  return {
    name: registryEntry.bandName,
    description: normalizeDescription(schema.description, registryEntry),
    inputSchema: finalSchema as Tool['inputSchema'],
  };
}

function buildBandToolDefinitions(): McpToolDefinition[] {
  const schemas = baseTools().getAnthropicToolSchemas({ includeMemory: memoryToolsEnabled() });

  return schemas.flatMap((schema) => {
    const tool = sdkSchemaToMcpTool(schema);
    if (!tool) return [];

    const sdkToolName = toSdkToolName(tool.name);
    if (!sdkToolName) return [];
    const roomScoped = ROOM_SCOPED_TOOLS.has(sdkToolName);
    return [
      {
        tool,
        async handler(args) {
          const consolidationBlocked = blockedDuringConsolidation(sdkToolName);
          if (consolidationBlocked) return consolidationBlocked;
          if (isMemoryTool(sdkToolName) && memoryDisabledForRun) return memoryDisabledResult(sdkToolName);

          let execArgs = args;
          let tools = baseTools();

          if (roomScoped) {
            const record = (args ?? {}) as Record<string, unknown>;
            const explicit = typeof record.chat_room_id === 'string' ? record.chat_room_id : undefined;
            const blocked = blockedInMainRoom(sdkToolName, Boolean(explicit));
            if (blocked) return blocked;
            const targetRoom = explicit ?? sessionRoomId();
            if (!targetRoom) {
              return errorResult(
                `${toBandToolName(sdkToolName)} needs a chat_room_id — this session has no current Band room.`,
              );
            }
            tools = sdkToolsForRoom(targetRoom);
            if (explicit) {
              const rest = { ...record };
              delete rest.chat_room_id;
              execArgs = rest;
            }
          } else {
            // Room-independent tools (e.g. create_chatroom) are still guarded
            // against mutation from within the main control room.
            const blocked = blockedInMainRoom(sdkToolName, false);
            if (blocked) return blocked;
          }

          const result = await tools.executeToolCall(sdkToolName, execArgs);
          if (isMemoryTool(sdkToolName) && isUnavailableMemoryResult(result)) {
            memoryDisabledForRun = true;
            return memoryDisabledResult(sdkToolName);
          }
          return formatToolResult(result);
        },
      },
    ];
  });
}

if (bandAgentToolsEnabled()) {
  registerTools(buildBandToolDefinitions());
}
