/**
 * Band lifecycle hook registration.
 *
 * Wires Band's tool-usage guidance + participant-memory load (startup) and
 * consolidation (shutdown) onto the generic lifecycle-hook seam in
 * lifecycle.ts, replacing the former hardcoded Band calls in index.ts main().
 * All three underlying functions self-guard (no-op when Band isn't configured /
 * the feature is off), so this is safe to register unconditionally.
 *
 * Band-owned: this file ships from the `band` branch and the /add-band skill
 * appends its side-effect import to the runner barrel (additive, like channel
 * self-registration). Core registers no lifecycle hooks of its own.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerStartHook, registerStopHook } from './lifecycle.js';
import { loadParticipantMemories } from './band-memory-load.js';
import { runMemoryConsolidation } from './band-memory-consolidate.js';

// BAND_* is canonical post-rename; THENVOI_* is honored as a legacy fallback.
function bandActive(): boolean {
  const agentId = process.env.BAND_AGENT_ID ?? process.env.THENVOI_AGENT_ID;
  return Boolean(agentId && agentId.length > 0);
}

/**
 * Band tool-usage guidance from `mcp-tools/band.instructions.md` — surfaced as a
 * start-hook addendum so it reaches the agent's system prompt. That guidance
 * conveys rules the `band_*` tool schemas do not (most importantly: Band only
 * routes/notifies MENTIONED messages, so an untagged reply is invisible). The
 * system prompt is composed solely from `systemContext.instructions` and there
 * is no `*.instructions.md` glob, so without this the file loads nowhere.
 * Reading failure is non-fatal — the room still functions without the prose.
 */
export function loadBandInstructions(): string {
  if (!bandActive()) return '';
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-tools', 'band.instructions.md');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    console.error(
      `[band-lifecycle] could not read band.instructions.md (continuing without): ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

// Band tool-usage guidance — registered first so it precedes any loaded
// participant-memory block in the system prompt.
registerStartHook(() => loadBandInstructions() || null);
registerStartHook(async () => (await loadParticipantMemories()) || null);
registerStopHook(async (ctx) => {
  await runMemoryConsolidation({
    provider: ctx.provider,
    providerName: ctx.providerName,
    cwd: ctx.cwd,
    continuation: ctx.continuation,
  });
});
