import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

function clearEnv(): void {
  delete process.env.THENVOI_ROOM_ID;
  delete process.env.THENVOI_AGENT_ID;
  delete process.env.THENVOI_REST_URL;
  delete process.env.THENVOI_API_KEY;
  delete process.env.THENVOI_IS_MAIN_CONTROL_ROOM;
  delete process.env.THENVOI_MEMORY_TOOLS;
  delete process.env.NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE;
}

beforeEach(() => {
  clearEnv();
});

afterEach(() => {
  clearEnv();
});

describe('Band.ai MCP tools', () => {
  it('registers concrete Band tools when Band env is present', async () => {
    process.env.THENVOI_ROOM_ID = 'room-1';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';
    process.env.THENVOI_MEMORY_TOOLS = 'true';

    await import('./band.js');
    const { listRegisteredToolNames } = await import('./server.js');

    expect(listRegisteredToolNames()).toContain('band_send_message');
    expect(listRegisteredToolNames()).toContain('band_send_event');
    expect(listRegisteredToolNames()).toContain('band_get_participants');
    expect(listRegisteredToolNames()).toContain('band_add_participant');
    expect(listRegisteredToolNames()).toContain('band_remove_participant');
    expect(listRegisteredToolNames()).toContain('band_list_memories');
    expect(listRegisteredToolNames()).toContain('band_store_memory');
  });

  it('blocks participant mutation tools in the main control room before calling Band', async () => {
    process.env.THENVOI_ROOM_ID = 'room-1';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';
    process.env.THENVOI_IS_MAIN_CONTROL_ROOM = 'true';

    await import('./band.js');
    const { getRegisteredTool } = await import('./server.js');
    const tool = getRegisteredTool('band_add_participant');

    const result = await tool!.handler({ name: 'User One' });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('blocked in the Band.ai main control room');
  });

  it('blocks non-memory Band tools during memory consolidation', async () => {
    process.env.THENVOI_ROOM_ID = 'room-1';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.NANOCLAW_MEMORY_CONSOLIDATION_ACTIVE = 'true';

    await import('./band.js');
    const { getRegisteredTool } = await import('./server.js');
    const tool = getRegisteredTool('band_send_message');

    const result = await tool!.handler({ content: 'should not send', mentions: [{ id: 'owner-1' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('blocked during Band.ai memory consolidation');
  });

  it('exposes chat_room_id on room-scoped tools so they can target any room', async () => {
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';

    await import('./band.js');
    const { getRegisteredTool } = await import('./server.js');

    const send = getRegisteredTool('band_send_message');
    const props = send!.tool.inputSchema.properties as Record<string, unknown> | undefined;
    expect(props && 'chat_room_id' in props).toBe(true);
  });

  it('requires chat_room_id for a room-scoped tool when the session has no current room', async () => {
    // Agent-scoped session (e.g. driven from Telegram): agent identity present,
    // but no BAND_ROOM_ID. clearEnv() in beforeEach already removed ROOM_ID.
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';

    await import('./band.js');
    const { getRegisteredTool } = await import('./server.js');
    const tool = getRegisteredTool('band_send_message');

    const result = await tool!.handler({ content: 'hi there', mentions: [{ id: 'peer-1' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('needs a chat_room_id');
  });

  // Regression guard: the SDK must be loaded via a lazy dynamic import inside a
  // try/catch, never as a top-level value import. The barrel imports band.js
  // unconditionally, so a top-level `import { ThenvoiLink } from '@band-ai/sdk'`
  // that throws (missing/broken SDK) would propagate up and stop
  // startMcpServer() from ever running — killing EVERY MCP tool, not just Band.
  // (The lazy path's graceful degradation is proven by running this suite with
  // the SDK import mocked to throw, in isolation.)
  it('loads the SDK lazily — no top-level value import of @band-ai/sdk', async () => {
    const src = await Bun.file(new URL('./band.ts', import.meta.url)).text();
    const topLevelValueImport = /^import\s+(?!type\b)[^;]*from\s+['"]@band-ai\/sdk(?:\/runtime)?['"]/m;
    expect(topLevelValueImport.test(src)).toBe(false);
    expect(src).toContain("await import('@band-ai/sdk')");
  });
});
