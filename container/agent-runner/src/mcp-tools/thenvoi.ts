import { ThenvoiClient } from '@thenvoi/rest-client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function thenvoiEnvPresent(): boolean {
  return Boolean(env('THENVOI_ROOM_ID') && env('THENVOI_AGENT_ID') && env('THENVOI_REST_URL'));
}

function client(): ThenvoiClient {
  const apiKey = env('THENVOI_API_KEY') ?? env('ONECLI_API_KEY') ?? '';
  return new ThenvoiClient({
    baseUrl: env('THENVOI_REST_URL'),
    apiKey,
  });
}

function roomId(): string {
  return env('THENVOI_ROOM_ID')!;
}

function mainControlRoom(): boolean {
  return env('THENVOI_IS_MAIN_CONTROL_ROOM') === 'true';
}

function memoryToolsEnabled(): boolean {
  return env('THENVOI_MEMORY_TOOLS') === 'true';
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

function blockedInMainRoom(tool: string): CallToolResult | null {
  if (!mainControlRoom()) return null;
  return errorResult(`${tool} is blocked in the Band.ai main control room. Use a regular Band room for participant or room mutations.`);
}

function asString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function runTool(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404') || message.toLowerCase().includes('not found')) {
      return errorResult(`Band.ai API endpoint is unavailable for this tool in this run: ${message}`);
    }
    return errorResult(message);
  }
}

const sendMessage: McpToolDefinition = {
  tool: {
    name: 'band_send_message',
    description: 'Send a text message to the current Band.ai room. Use handles in message text for mentions when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send to the current Band.ai room.' },
        mentions: {
          type: 'array',
          description: 'Optional mention objects with id plus optional handle/name. Prefer handles in text, not raw UUIDs.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              handle: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    return runTool(async () => {
      const text = asString(args, 'text');
      if (!text) return errorResult('text is required');
      const mentions = Array.isArray(args.mentions) ? args.mentions : [];
      const result = await client().agentApiMessages.createAgentChatMessage(roomId(), {
        message: { content: text, mentions: mentions as Array<{ id: string; handle?: string; name?: string }> },
      });
      const resultObject = result as unknown as { id?: unknown; message?: { id?: unknown } };
      const id = typeof resultObject.id === 'string'
        ? resultObject.id
        : typeof resultObject.message?.id === 'string'
          ? resultObject.message.id
          : 'unknown';
      return ok(`Band.ai message sent (id: ${id})`);
    });
  },
};

const createThought: McpToolDefinition = {
  tool: {
    name: 'band_thought',
    description: 'Post a concise visible Band.ai thought/status event. Do not include hidden reasoning, secrets, raw tool payloads, or private transcript dumps.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Short user-visible status update.' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    return runTool(async () => {
      const text = asString(args, 'text');
      if (!text) return errorResult('text is required');
      await client().agentApiEvents.createAgentChatEvent(roomId(), {
        event: { content: text, message_type: 'thought' },
      });
      return ok('Band.ai thought posted');
    });
  },
};

const listParticipants: McpToolDefinition = {
  tool: {
    name: 'band_list_participants',
    description: 'List participants in the current Band.ai room.',
    inputSchema: { type: 'object', properties: {} },
  },
  async handler() {
    return runTool(async () => {
      const result = await client().agentApiParticipants.listAgentChatParticipants(roomId());
      return ok(JSON.stringify(result, null, 2));
    });
  },
};

const addParticipant: McpToolDefinition = {
  tool: {
    name: 'band_add_participant',
    description: 'Add a participant to the current Band.ai room. Blocked in the main control room.',
    inputSchema: {
      type: 'object',
      properties: {
        participantId: { type: 'string', description: 'Band participant id to add.' },
      },
      required: ['participantId'],
    },
  },
  async handler(args) {
    const blocked = blockedInMainRoom('band_add_participant');
    if (blocked) return blocked;
    return runTool(async () => {
      const participantId = asString(args, 'participantId');
      if (!participantId) return errorResult('participantId is required');
      await client().agentApiParticipants.addAgentChatParticipant(roomId(), {
        participant: { participant_id: participantId },
      });
      return ok('Band.ai participant added');
    });
  },
};

const removeParticipant: McpToolDefinition = {
  tool: {
    name: 'band_remove_participant',
    description: 'Remove a participant from the current Band.ai room. Blocked in the main control room.',
    inputSchema: {
      type: 'object',
      properties: {
        participantId: { type: 'string', description: 'Band participant id to remove.' },
      },
      required: ['participantId'],
    },
  },
  async handler(args) {
    const blocked = blockedInMainRoom('band_remove_participant');
    if (blocked) return blocked;
    return runTool(async () => {
      const participantId = asString(args, 'participantId');
      if (!participantId) return errorResult('participantId is required');
      await client().agentApiParticipants.removeAgentChatParticipant(roomId(), participantId);
      return ok('Band.ai participant removed');
    });
  },
};

const listMemories: McpToolDefinition = {
  tool: {
    name: 'band_list_memories',
    description: 'List Band.ai shared memories available to this agent when the memory API is enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectId: { type: 'string', description: 'Optional subject UUID.' },
        query: { type: 'string', description: 'Optional full-text query.' },
      },
    },
  },
  async handler(args) {
    if (!memoryToolsEnabled()) return errorResult('Band.ai memory tools are disabled for this run.');
    return runTool(async () => {
      const result = await client().agentApiMemories.listAgentMemories({
        subject_id: asString(args, 'subjectId'),
        content_query: asString(args, 'query'),
        page_size: 20,
        status: 'active',
      });
      return ok(JSON.stringify(result, null, 2));
    });
  },
};

const storeMemory: McpToolDefinition = {
  tool: {
    name: 'band_store_memory',
    description: 'Store a Band.ai shared memory when the memory API is enabled. Store cross-room user facts here, not room-local notes.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory content.' },
        thought: { type: 'string', description: 'Brief reason for storing this memory.' },
        subjectId: { type: 'string', description: 'Optional subject UUID for subject-scoped memories.' },
        scope: { type: 'string', enum: ['subject', 'organization'] },
        segment: { type: 'string', enum: ['user', 'agent', 'tool', 'guideline'] },
        system: { type: 'string', enum: ['sensory', 'working', 'long_term'] },
        type: { type: 'string', enum: ['iconic', 'echoic', 'haptic', 'episodic', 'semantic', 'procedural'] },
      },
      required: ['content', 'thought'],
    },
  },
  async handler(args) {
    if (!memoryToolsEnabled()) return errorResult('Band.ai memory tools are disabled for this run.');
    return runTool(async () => {
      const content = asString(args, 'content');
      const thought = asString(args, 'thought');
      if (!content || !thought) return errorResult('content and thought are required');
      const result = await client().agentApiMemories.createAgentMemory({
        memory: {
          content,
          thought,
          subject_id: asString(args, 'subjectId'),
          scope: (asString(args, 'scope') ?? (asString(args, 'subjectId') ? 'subject' : 'organization')) as 'subject' | 'organization',
          segment: (asString(args, 'segment') ?? 'user') as 'user',
          system: (asString(args, 'system') ?? 'long_term') as 'long_term',
          type: (asString(args, 'type') ?? 'semantic') as 'semantic',
        },
      });
      const resultObject = result as unknown as { id?: unknown; memory?: { id?: unknown } };
      const id = typeof resultObject.id === 'string'
        ? resultObject.id
        : typeof resultObject.memory?.id === 'string'
          ? resultObject.memory.id
          : 'unknown';
      return ok(`Band.ai memory stored (id: ${id})`);
    });
  },
};

if (thenvoiEnvPresent()) {
  registerTools([
    sendMessage,
    createThought,
    listParticipants,
    addParticipant,
    removeParticipant,
    listMemories,
    storeMemory,
  ]);
}
