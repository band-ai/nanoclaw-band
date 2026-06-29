/**
 * Container start/stop lifecycle hooks (Track A Step 6 seam).
 *
 * A channel/provider registers a start hook (returns an optional system-prompt
 * addendum appended at startup) and/or a stop hook (runs after the poll loop
 * returns, during graceful shutdown / exit). Core ships no hooks; channels add
 * them via a side-effect import (see band-lifecycle.ts). When nothing is
 * registered, runStartHooks returns [] and runStopHooks is a no-op.
 *
 * This replaces the former hardcoded Band memory load/consolidate calls in
 * index.ts main() — those now ride the hooks via band-lifecycle.ts.
 */
import type { AgentProvider } from './providers/types.js';

export interface StartHookContext {
  assistantName?: string;
  cwd: string;
}

export interface StopHookContext {
  providerName: string;
  cwd: string;
  continuation?: string;
  provider: AgentProvider;
}

/** Returns an optional system-prompt addendum appended at startup. */
export type StartHook = (ctx: StartHookContext) => Promise<string | null> | string | null;
/** Runs after the poll loop returns (graceful shutdown / exit). */
export type StopHook = (ctx: StopHookContext) => Promise<void> | void;

const startHooks: StartHook[] = [];
const stopHooks: StopHook[] = [];

export function registerStartHook(fn: StartHook): void {
  startHooks.push(fn);
}

export function registerStopHook(fn: StopHook): void {
  stopHooks.push(fn);
}

export async function runStartHooks(ctx: StartHookContext): Promise<string[]> {
  const out: string[] = [];
  for (const h of startHooks) {
    const r = await h(ctx);
    if (r) out.push(r);
  }
  return out;
}

export async function runStopHooks(ctx: StopHookContext): Promise<void> {
  for (const h of stopHooks) {
    try {
      await h(ctx);
    } catch (e) {
      console.error('[lifecycle] stop hook failed', e);
    }
  }
}
