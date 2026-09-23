// Fork-only: the user-visible-tool delivery seam in the poll loop. Kept out of
// upstream's integration.test.ts so upstream merges don't conflict on it.
// Tests wait on the provider's result being handled, not on the pending-row
// claim: the loop marks rows 'processing' before the provider runs.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

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

describe('poll loop — user-visible tool delivery', () => {
  it('does not re-send a wrapped final text after a user-visible MCP tool delivered the reply', async () => {
    insertMessage(
      'm-tool',
      { sender: 'Alice', text: 'Reply with the Band tool' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new ToolSendingProvider('<message to="discord-test">Sent.</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.resultHandled, 2000);
    controller.abort();

    expect(getUndeliveredMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('does not nudge the agent to re-send after a user-visible MCP tool delivered the reply', async () => {
    insertMessage(
      'm-tool',
      { sender: 'Alice', text: 'Reply with the Band tool' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new ToolSendingProvider('Sent.');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.resultHandled, 2000);
    controller.abort();

    expect(provider.pushes).toEqual([]);

    await loopPromise.catch(() => {});
  });
});

/** Reports a user-visible MCP send, then ends the turn with `resultText`. Records follow-up pushes. */
class ToolSendingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];
  resultHandled = false;

  constructor(private readonly resultText: string) {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(_input: QueryInput): AgentQuery {
    const resultText = this.resultText;
    const self = this;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: 'tool-session' };
        yield { type: 'user_visible_tool', name: 'mcp__nanoclaw__band_send_message' };
        yield { type: 'result', text: resultText };
        // Resumes only once the loop has finished handling the result event.
        self.resultHandled = true;
      },
    };

    return {
      push: (message) => {
        this.pushes.push(message);
      },
      end: () => {},
      events,
      abort: () => {},
    };
  }
}

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
