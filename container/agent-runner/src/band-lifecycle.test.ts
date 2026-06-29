import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { loadBandInstructions } from './band-lifecycle.js';

const KEYS = ['BAND_AGENT_ID', 'THENVOI_AGENT_ID'];
let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const k of KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('loadBandInstructions', () => {
  it('returns empty when Band is not active', () => {
    expect(loadBandInstructions()).toBe('');
  });

  it('returns the Band guidance when BAND_AGENT_ID is set', () => {
    process.env.BAND_AGENT_ID = 'agent-1';
    const out = loadBandInstructions();
    expect(out).toContain('Band.ai tools');
    // The mention-gating rule the tool schemas do not convey.
    expect(out).toContain('Always tag the recipient');
  });

  it('honors the legacy THENVOI_AGENT_ID alias', () => {
    process.env.THENVOI_AGENT_ID = 'agent-1';
    expect(loadBandInstructions().length).toBeGreaterThan(0);
  });
});
