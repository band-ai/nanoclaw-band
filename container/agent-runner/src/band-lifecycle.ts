/**
 * Band lifecycle hook registration.
 *
 * Wires Band's participant-memory load (startup) and consolidation (shutdown)
 * onto the generic lifecycle-hook seam in lifecycle.ts, replacing the former
 * hardcoded Band calls in index.ts main(). Both underlying functions already
 * self-guard (no-op when Band isn't configured / the feature is off), so this
 * is safe to register unconditionally.
 *
 * Band-owned: this file ships from the `band` branch and the /add-band skill
 * appends its side-effect import to the runner barrel (additive, like channel
 * self-registration). Core registers no lifecycle hooks of its own.
 */
import { registerStartHook, registerStopHook } from './lifecycle.js';
import { loadParticipantMemories } from './band-memory-load.js';
import { runMemoryConsolidation } from './band-memory-consolidate.js';

registerStartHook(async () => (await loadParticipantMemories()) || null);
registerStopHook(async (ctx) => {
  await runMemoryConsolidation({
    provider: ctx.provider,
    providerName: ctx.providerName,
    cwd: ctx.cwd,
    continuation: ctx.continuation,
  });
});
