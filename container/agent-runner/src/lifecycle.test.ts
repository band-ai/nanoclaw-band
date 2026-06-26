/**
 * Lifecycle-hook registry (Step 6 seam): start hooks contribute optional
 * system-prompt addenda; stop hooks run after the poll loop, with errors
 * swallowed so one failing hook can't block the others or crash shutdown.
 */
import { describe, it, expect } from 'bun:test';

import {
  registerStartHook,
  registerStopHook,
  runStartHooks,
  runStopHooks,
  type StopHookContext,
} from './lifecycle.js';

const stopCtx: StopHookContext = {
  providerName: 'mock',
  cwd: '/workspace/agent',
  continuation: undefined,
  // Minimal AgentProvider stand-in — hooks under test don't touch it.
  provider: {
    supportsNativeSlashCommands: false,
    query: () => {
      throw new Error('not used');
    },
    isSessionInvalid: () => false,
  },
};

describe('lifecycle hooks', () => {
  it('collects non-null start-hook addenda and drops null/empty ones', async () => {
    registerStartHook(() => 'ADDENDUM_A');
    registerStartHook(() => null);
    registerStartHook(async () => 'ADDENDUM_B');

    const out = await runStartHooks({ cwd: '/workspace/agent' });
    expect(out).toContain('ADDENDUM_A');
    expect(out).toContain('ADDENDUM_B');
    expect(out).not.toContain(null as unknown as string);
  });

  it('runs every stop hook even when one throws', async () => {
    // Unique markers so the assertions are robust to any hooks registered by
    // earlier tests in this file (the registry is module-global with no reset).
    const calls: string[] = [];
    registerStopHook(() => {
      calls.push('stop-throws');
      throw new Error('boom');
    });
    registerStopHook(async () => {
      calls.push('stop-ok');
    });

    await expect(runStopHooks(stopCtx)).resolves.toBeUndefined();
    // Both of our hooks ran (the throw didn't block the later one) and in order.
    expect(calls).toContain('stop-throws');
    expect(calls).toContain('stop-ok');
    expect(calls.indexOf('stop-throws')).toBeLessThan(calls.indexOf('stop-ok'));
  });
});
