import { describe, it, expect } from 'bun:test';
import { markUserVisibleTool, isUserVisibleToolName } from './server.js';

describe('user-visible tool registry', () => {
  it('seeds mcp__nanoclaw__send_message as baseline', () => {
    expect(isUserVisibleToolName('mcp__nanoclaw__send_message')).toBe(true);
  });

  it('returns false for unknown tools', () => {
    expect(isUserVisibleToolName('Bash')).toBe(false);
    expect(isUserVisibleToolName('mcp__nanoclaw__unknown_tool')).toBe(false);
  });

  it('marks a new tool as user-visible', () => {
    markUserVisibleTool('mcp__nanoclaw__band_send_message');
    expect(isUserVisibleToolName('mcp__nanoclaw__band_send_message')).toBe(true);
  });
});
