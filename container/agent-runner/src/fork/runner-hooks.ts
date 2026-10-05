/**
 * Fork: main() lifecycle glue around the channel start/stop hook registry
 * (lifecycle.ts). Channel lifecycle modules (e.g. band-lifecycle.ts)
 * self-register through a side-effect import in index.ts placed after the
 * providers barrel.
 */
import { getContinuation } from '../db/session-state.js';
import { runStartHooks, runStopHooks, type StartHookContext, type StopHookContext } from '../lifecycle.js';

/** Append each start-hook addendum (e.g. Band memory pre-load) to the system-prompt instructions. */
export async function withStartAddenda(instructions: string, ctx: StartHookContext): Promise<string> {
  for (const addendum of await runStartHooks(ctx)) {
    instructions = `${instructions}\n\n${addendum}`;
  }
  return instructions;
}

/**
 * Graceful shutdown: when the host stops the container (SIGTERM from
 * `docker stop`) or on SIGINT, abort the poll loop so the in-flight query can
 * wind down cleanly and the stop hooks run before exit. Returns the signal to
 * hand to runPollLoop.
 */
export function installShutdownSignal(log: (msg: string) => void): AbortSignal {
  const shutdown = new AbortController();
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${sig} — aborting poll loop`);
    shutdown.abort();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  return shutdown.signal;
}

/** Run stop hooks after the poll loop exits, with the provider's current continuation. Hook errors are swallowed. */
export async function runStopHooksAfterLoop(ctx: Omit<StopHookContext, 'continuation'>): Promise<void> {
  await runStopHooks({ ...ctx, continuation: getContinuation(ctx.providerName) });
}
