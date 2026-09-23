import { describe, expect, test, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  CONSOLIDATION_MARKER_PATH,
  memoryConsolidationActive,
  runMemoryConsolidation,
  setConsolidationMarkerForTest,
} from './band-memory-consolidate.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

const ENV_KEYS = ['THENVOI_MEMORY_TOOLS', 'THENVOI_MEMORY_CONSOLIDATION', 'NANOCLAW_CHANNEL'];
let snapshot: Record<string, string | undefined>;
let markerDir: string;
let marker: string;

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  markerDir = mkdtempSync(path.join(tmpdir(), 'band-consolidate-'));
  marker = path.join(markerDir, 'marker');
  setConsolidationMarkerForTest(marker);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  setConsolidationMarkerForTest();
  rmSync(markerDir, { recursive: true, force: true });
});

function enableConsolidation(): void {
  process.env.THENVOI_MEMORY_TOOLS = 'true';
  process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
  process.env.NANOCLAW_CHANNEL = 'thenvoi';
}

/**
 * Fake provider that records whether the consolidation marker existed when
 * `query()` was called and while each event was consumed. `failAfterEvents`
 * makes the events stream throw once the listed events have been yielded.
 */
function makeProvider(
  events: ProviderEvent[],
  opts: { failAfterEvents?: boolean } = {},
): { provider: AgentProvider; query: Mock<(input: QueryInput) => AgentQuery>; markerSeen: boolean[] } {
  const markerSeen: boolean[] = [];
  const queryFn = mock((_input: QueryInput): AgentQuery => {
    markerSeen.push(existsSync(marker));
    return {
      push: () => {},
      end: () => {},
      abort: () => {},
      events: (async function* () {
        for (const event of events) {
          markerSeen.push(existsSync(marker));
          yield event;
        }
        if (opts.failAfterEvents) throw new Error('stream broke');
      })(),
    };
  });
  return {
    provider: {
      supportsNativeSlashCommands: false,
      query: queryFn,
      isSessionInvalid: () => false,
    } as AgentProvider,
    query: queryFn,
    markerSeen,
  };
}

describe('runMemoryConsolidation', () => {
  test('skips when feature flag is off', async () => {
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).not.toHaveBeenCalled();
  });

  test('skips when channel is not thenvoi', async () => {
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    process.env.NANOCLAW_CHANNEL = 'discord';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).not.toHaveBeenCalled();
  });

  test('skips when no continuation is available', async () => {
    process.env.THENVOI_MEMORY_TOOLS = 'true';
    process.env.THENVOI_MEMORY_CONSOLIDATION = 'true';
    process.env.NANOCLAW_CHANNEL = 'thenvoi';
    const { provider, query } = makeProvider([]);

    await runMemoryConsolidation({
      provider,
      providerName: 'claude',
      cwd: '/workspace/agent',
      continuation: undefined,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test('drains events and forwards continuation to provider', async () => {
    enableConsolidation();
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 'sess-2' },
      { type: 'result', text: 'done' },
    ];
    const { provider, query } = makeProvider(events);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(query).toHaveBeenCalledTimes(1);
    const callArg = query.mock.calls[0][0] as {
      continuation: string;
      cwd: string;
      prompt: string;
    };
    expect(callArg.continuation).toBe('sess-1');
    expect(callArg.cwd).toBe('/workspace/agent');
    expect(callArg.prompt).toContain('memory consolidation mode');
    expect(callArg.prompt).toContain('mcp__nanoclaw__band_list_memories');
    expect(callArg.prompt).toContain('Do not store user- or agent-specific memories');
  });

  test('holds the consolidation marker while the provider runs, then removes it', async () => {
    enableConsolidation();
    const { provider, markerSeen } = makeProvider([
      { type: 'init', continuation: 'sess-2' },
      { type: 'result', text: 'done' },
    ]);

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    // query() call + both events all observed the marker.
    expect(markerSeen).toEqual([true, true, true]);
    expect(existsSync(marker)).toBe(false);
  });

  test('removes the marker when the event stream throws', async () => {
    enableConsolidation();
    const { provider, markerSeen } = makeProvider([{ type: 'init', continuation: 'sess-2' }], {
      failAfterEvents: true,
    });

    await runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' });
    expect(markerSeen).toEqual([true, true]);
    expect(existsSync(marker)).toBe(false);
  });

  test('removes the marker when query() itself throws', async () => {
    enableConsolidation();
    let markerSeenInQuery = false;
    const provider = {
      supportsNativeSlashCommands: false,
      query: () => {
        markerSeenInQuery = existsSync(marker);
        throw new Error('provider down');
      },
      isSessionInvalid: () => false,
    } as AgentProvider;

    await expect(
      runMemoryConsolidation({ provider, providerName: 'claude', cwd: '/workspace/agent', continuation: 'sess-1' }),
    ).rejects.toThrow('provider down');
    expect(markerSeenInQuery).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test('memoryConsolidationActive reflects the marker file', async () => {
    expect(memoryConsolidationActive()).toBe(false);
    await Bun.write(marker, '');
    expect(memoryConsolidationActive()).toBe(true);
  });

  test('default marker path is the container-local contract path', () => {
    expect(CONSOLIDATION_MARKER_PATH).toBe('/tmp/nanoclaw-memory-consolidation-active');
  });
});
