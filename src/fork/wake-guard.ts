import { log } from '../log.js';

/**
 * Fork: `stopReason` is set by `killContainer` before the stop is even issued —
 * a runtime that has one is on its way out. Treating it as "not running"
 * (rather than the `has()` check's implicit "already running") lets the
 * inbound row stay pending so host-sweep retries once the stop settles,
 * instead of a wake mid-shutdown silently claiming success for a session
 * about to disappear. Returns true when `wakeContainer` must report false.
 */
export function isStoppingForWake(sessionId: string, stopReason: string | undefined): boolean {
  if (stopReason === undefined) return false;
  log.debug('Container is stopping; wake will retry after shutdown', { sessionId, reason: stopReason });
  return true;
}
