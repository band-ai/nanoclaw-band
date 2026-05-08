import { ThenvoiLink } from '@thenvoi/sdk';
import { AgentTools } from '@thenvoi/sdk/runtime';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolsProtocol } from '@thenvoi/sdk';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MUTATION_TOOLS_BLOCKED_IN_MAIN_ROOM = new Set([
  'thenvoi_add_participant',
  'thenvoi_remove_participant',
  'thenvoi_create_chatroom',
]);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function thenvoiEnvPresent(): boolean {
  return Boolean(env('THENVOI_ROOM_ID') && env('THENVOI_AGENT_ID') && env('THENVOI_REST_URL'));
}

function roomId(): string {
  return env('THENVOI_ROOM_ID')!;
}

function mainControlRoom(): boolean {
  return env('THENVOI_IS_MAIN_CONTROL_ROOM') === 'true';
}

function memoryToolsEnabled(): boolean {
  return env('THENVOI_MEMORY_TOOLS') === 'true' && !memoryDisabledForRun;
}

function isMemoryTool(sdkToolName: string): boolean {
  return sdkToolName.includes('memory') || sdkToolName.includes('memories');
}

let cachedTools: AgentToolsProtocol | null = null;
let memoryDisabledForRun = false;

function apiKey(): string {
  return env('THENVOI_API_KEY') ?? env('ONECLI_API_KEY') ?? '';
}

function restUrl(): string | undefined {
  return env('THENVOI_REST_URL');
}

function sdkTools(): AgentToolsProtocol {
  if (cachedTools) return cachedTools;

  const link = new ThenvoiLink({
    agentId: env('THENVOI_AGENT_ID')!,
    apiKey: apiKey(),
    restUrl: restUrl(),
  });
  cachedTools = new AgentTools({
    roomId: roomId(),
    rest: link.rest,
    capabilities: {
      peers: true,
      contacts: true,
      memory: memoryToolsEnabled(),
    },
  }).getAdapterTools();
  return cachedTools;
}

function toBandToolName(sdkToolName: string): string {
  return sdkToolName.replace(/^thenvoi_/, 'band_');
}

function toSdkToolName(bandToolName: string): string {
  return bandToolName.replace(/^band_/, 'thenvoi_');
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

function memoryDisabledResult(toolName: string): CallToolResult {
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

function blockedInMainRoom(sdkToolName: string): CallToolResult | null {
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

function normalizeDescription(description: unknown): string {
  const text = typeof description === 'string' ? description : 'Band.ai platform tool.';
  return text.replace(/Thenvoi/g, 'Band.ai').replace(/thenvoi_/g, 'band_');
}

function sdkSchemaToMcpTool(schema: Record<string, unknown>): Tool | null {
  const sdkName = typeof schema.name === 'string' ? schema.name : undefined;
  const inputSchema = schema.input_schema && typeof schema.input_schema === 'object' ? schema.input_schema : undefined;
  if (!sdkName || !sdkName.startsWith('thenvoi_') || !inputSchema) return null;

  return {
    name: toBandToolName(sdkName),
    description: normalizeDescription(schema.description),
    inputSchema: inputSchema as Tool['inputSchema'],
  };
}

function buildBandToolDefinitions(): McpToolDefinition[] {
  const tools = sdkTools();
  const schemas = tools.getAnthropicToolSchemas({ includeMemory: memoryToolsEnabled() });

  return schemas.flatMap((schema) => {
    const tool = sdkSchemaToMcpTool(schema);
    if (!tool) return [];

    const sdkToolName = toSdkToolName(tool.name);
    return [
      {
        tool,
        async handler(args) {
          const blocked = blockedInMainRoom(sdkToolName);
          if (blocked) return blocked;
          if (isMemoryTool(sdkToolName) && memoryDisabledForRun) return memoryDisabledResult(sdkToolName);
          const result = await sdkTools().executeToolCall(sdkToolName, args);
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

if (thenvoiEnvPresent()) {
  registerTools(buildBandToolDefinitions());
}
