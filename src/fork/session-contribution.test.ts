import { describe, expect, it } from 'vitest';

import { mergeContainerContributions } from './session-contribution.js';

describe('mergeContainerContributions', () => {
  it('round-trips mcpServers and userVisibleTools from a channel contribution', () => {
    const merged = mergeContainerContributions(
      {},
      {
        env: { BAND_REST_URL: 'https://api' },
        mcpServers: { band: { command: 'thenvoi-mcp', args: [], env: {} } },
        userVisibleTools: ['mcp__nanoclaw__band_send_message'],
      },
    );
    expect(merged.mcpServers).toEqual({ band: { command: 'thenvoi-mcp', args: [], env: {} } });
    expect(merged.userVisibleTools).toEqual(['mcp__nanoclaw__band_send_message']);
    expect(merged.env).toEqual({ BAND_REST_URL: 'https://api' });
  });

  it('concatenates userVisibleTools and shallow-merges mcpServers across both sides', () => {
    const merged = mergeContainerContributions(
      { mcpServers: { a: { command: 'a', args: [] } }, userVisibleTools: ['mcp__nanoclaw__send_message'] },
      { mcpServers: { b: { command: 'b', args: [] } }, userVisibleTools: ['mcp__nanoclaw__band_send_message'] },
    );
    expect(Object.keys(merged.mcpServers ?? {}).sort()).toEqual(['a', 'b']);
    expect(merged.userVisibleTools).toEqual(['mcp__nanoclaw__send_message', 'mcp__nanoclaw__band_send_message']);
  });

  it('defaults missing fields to empty', () => {
    const merged = mergeContainerContributions({}, {});
    expect(merged.mounts).toEqual([]);
    expect(merged.env).toEqual({});
    expect(merged.mcpServers).toEqual({});
    expect(merged.userVisibleTools).toEqual([]);
  });
});
