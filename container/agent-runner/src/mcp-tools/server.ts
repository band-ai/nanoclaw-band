/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export function listRegisteredToolNames(): string[] {
  return allTools.map((t) => t.tool.name);
}

export function getRegisteredTool(name: string): McpToolDefinition | undefined {
  return toolMap.get(name);
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}

// User-visible tool registry. The Claude provider emits a 'user_visible_tool'
// event when one of these tool names appears in an assistant message, which
// causes the poll loop to show typing indicators. Core seeds
// 'mcp__nanoclaw__send_message'; channels add their own names at startup
// (e.g. Band adds 'mcp__nanoclaw__band_send_message') via the
// NANOCLAW_USER_VISIBLE_TOOLS env var seeded by buildContainerArgs.

const userVisibleTools = new Set<string>(['mcp__nanoclaw__send_message']);

export function markUserVisibleTool(name: string): void {
  userVisibleTools.add(name);
}

export function isUserVisibleToolName(name: string): boolean {
  return userVisibleTools.has(name);
}
