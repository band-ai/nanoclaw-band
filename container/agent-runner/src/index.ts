/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All message IO goes through the registered mailbox.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     mailbox state     ← selected implementation
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       CLAUDE.md       ← composed project document (RO nested mount)
 *       container.json  ← per-group config (RO nested mount)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
// Channel lifecycle-hook modules self-register on import (start/stop hooks).
// Such an import must follow the providers barrel (so providers register
// first) and precede the runStartHooks call below; channel install skills
// append their `import './<channel>-lifecycle.js';` here.
import { createProvider, type ProviderName } from './providers/factory.js';
import { buildMcpServers } from './mcp-servers.js';
import { runStartHooks, runStopHooks } from './lifecycle.js';
import { runPollLoop } from './poll-loop.js';
import { getContinuation } from './db/session-state.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares one persistent memory tree. Legacy imports are an
  // operator-run migration and never happen in this normal startup path.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — one flat file the host composes per spawn
  // with every instruction source inlined, no imports. Memory is supplied
  // separately by each provider's native lifecycle hook.
  const taskId = getTaskSeriesId();
  let instructions = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // Start hooks: channel/provider callbacks that may return a system-prompt
  // addendum (e.g. Band memory pre-load). Core ships no hooks; channels
  // register them via band-lifecycle.ts (imported as a side effect).
  const startAddenda = await runStartHooks({ assistantName: config.assistantName || undefined, cwd: CWD });
  for (const addendum of startAddenda) {
    instructions = `${instructions}\n\n${addendum}`;
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  const mcpEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  const mcpServers = buildMcpServers({
    builtin: {
      nanoclaw: {
        command: 'bun',
        args: ['run', mcpServerPath],
        env: mcpEnv,
      },
    },
    configServers: config.mcpServers,
    mcpEnv,
    extraMcpJson: process.env.NANOCLAW_EXTRA_MCP_SERVERS,
    log,
  });

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  // Graceful shutdown: when the host stops the container (SIGTERM from
  // `docker stop`), abort the poll loop so the in-flight query can wind
  // down cleanly. After the loop returns, Band.ai consolidation runs
  // (no-op when not enabled) before the process exits.
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

  try {
    await runPollLoop({
      provider,
      providerName,
      cwd: CWD,
      systemContext: { instructions },
      signal: shutdown.signal,
    });
  } finally {
    await mailbox.stop();
  }

  // Stop hooks: run after poll loop exits (on SIGTERM/SIGINT). Errors are
  // swallowed per hook so one failure can't block the others.
  const continuation = getContinuation(providerName);
  await runStopHooks({ provider, providerName, cwd: CWD, continuation });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
