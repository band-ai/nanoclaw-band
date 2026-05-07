import { afterEach, describe, expect, it } from 'bun:test';

function clearEnv(): void {
  delete process.env.THENVOI_ROOM_ID;
  delete process.env.THENVOI_AGENT_ID;
  delete process.env.THENVOI_REST_URL;
  delete process.env.THENVOI_API_KEY;
  delete process.env.THENVOI_IS_MAIN_CONTROL_ROOM;
  delete process.env.THENVOI_MEMORY_TOOLS;
}

afterEach(() => {
  clearEnv();
});

describe('Band.ai MCP tools', () => {
  it('registers concrete Band tools when Band env is present', async () => {
    process.env.THENVOI_ROOM_ID = 'room-1';
    process.env.THENVOI_AGENT_ID = 'agent-1';
    process.env.THENVOI_REST_URL = 'https://band.example.test';

    await import('./thenvoi.js');
    const { listRegisteredToolNames } = await import('./server.js');

    expect(listRegisteredToolNames()).toContain('band_send_message');
    expect(listRegisteredToolNames()).toContain('band_thought');
    expect(listRegisteredToolNames()).toContain('band_list_participants');
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

    await import('./thenvoi.js');
    const { getRegisteredTool } = await import('./server.js');
    const tool = getRegisteredTool('band_add_participant');

    const result = await tool!.handler({ participantId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('blocked in the Band.ai main control room');
  });
});
