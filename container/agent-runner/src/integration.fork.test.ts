import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange, QueryInput } from './providers/types.js';

const MOCK_PROVIDER_CONTRACT = {
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
} as const;

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration (fork)', () => {
  it('should not fallback-send final text after a user-visible MCP tool sent the reply', async () => {
    insertMessage(
      'm-tool',
      { sender: 'Alice', text: 'Reply with the Band tool' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new ToolSendingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.exchanges.length > 0, 2000);
    controller.abort();

    expect(getPendingMessages()).toHaveLength(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
    // No wrap-nudge retry, and the exchange is archived as delivered.
    expect(provider.pushes).toEqual([]);
    expect(provider.exchanges.map((e) => [e.result, e.status])).toEqual([['Sent.', 'completed']]);

    await loopPromise.catch(() => {});
  });
});

class ToolSendingProvider implements AgentProvider {
  readonly pushes: string[] = [];
  readonly exchanges: ProviderExchange[] = [];

  registerMemorySessionHook(): void {}

  onExchangeComplete(exchange: ProviderExchange): void {
    this.exchanges.push(exchange);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(_input: QueryInput): AgentQuery {
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: 'tool-session' };
        yield { type: 'user_visible_tool', name: 'mcp__nanoclaw__band_send_message' };
        yield { type: 'result', text: 'Sent.' };
      },
    };

    return {
      push: (message) => this.pushes.push(message),
      end: () => {},
      events,
      abort: () => {},
    };
  }
}

// The poll loop polls the session DB on real intervals, so these helpers wait on
// wall-clock time; fake timers would not advance its SQLite-backed polling.
function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const stopped = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => stopped.reject(new Error('aborted')));
  setTimeout(() => stopped.reject(new Error('timeout')), timeoutMs);
  return Promise.race([
    runPollLoop({ provider, providerContract: MOCK_PROVIDER_CONTRACT, providerName: 'mock', cwd: '/tmp', signal }),
    stopped.promise,
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await Bun.sleep(50);
  }
}
