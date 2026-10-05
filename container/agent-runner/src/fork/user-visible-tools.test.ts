import { describe, it, expect } from 'bun:test';

import {
  isUserVisibleToolName,
  markUserVisibleTool,
  seedUserVisibleTools,
  userVisibleToolEvents,
  UserVisibleToolTurn,
} from './user-visible-tools.js';

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

  it('seeds string names from JSON and ignores malformed input', () => {
    seedUserVisibleTools('["mcp__x__seeded", 42]');
    seedUserVisibleTools('not json');
    expect(isUserVisibleToolName('mcp__x__seeded')).toBe(true);
  });
});

describe('userVisibleToolEvents', () => {
  it('yields only registered tool_use names', () => {
    const message = {
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'mcp__nanoclaw__send_message' },
        ],
      },
    };
    expect([...userVisibleToolEvents(message)]).toEqual([
      { type: 'user_visible_tool', name: 'mcp__nanoclaw__send_message' },
    ]);
  });
});

describe('UserVisibleToolTurn', () => {
  it('suppresses only a non-empty, non-error result after a user-visible tool, then resets', () => {
    const turn = new UserVisibleToolTurn();
    expect(turn.suppressesResult('Sent.', false)).toBe(false);

    turn.observe({ type: 'user_visible_tool', name: 'mcp__nanoclaw__send_message' });
    expect(turn.suppressesResult('Sent.', false)).toBe(true);
    expect(turn.suppressesResult('Sent.', false)).toBe(false);

    turn.observe({ type: 'user_visible_tool', name: 'mcp__nanoclaw__send_message' });
    expect(turn.suppressesResult('', false)).toBe(false);
    expect(turn.suppressesResult('next turn', false)).toBe(false);

    turn.observe({ type: 'user_visible_tool', name: 'mcp__nanoclaw__send_message' });
    expect(turn.suppressesResult('boom', true)).toBe(false);
  });
});
