/**
 * Fork: stop grace periods for container shutdown. Most kill reasons are
 * recovery paths (stuck claim, absolute ceiling, rebuild) and should not leave
 * the host blocked behind a dying container for minutes. A caller that needs a
 * real shutdown window (e.g. Band.ai memory consolidation) opts in by
 * including `GRACEFUL_STOP_TAG` in its stop reason.
 *
 * Producer: `absoluteCeilingStopReason` (graceful-stop.ts), for adapters that
 * declare `needsGracefulStop`. Consumer: `DockerHandle.stop()`, which resolves
 * the `docker stop -t` grace through `stopGraceForReason`.
 */
export const FAST_STOP_GRACE_SEC = 10;
export const GRACEFUL_STOP_GRACE_SEC = 30 * 60;
/** Substring of a stop reason that requests the long grace window. */
export const GRACEFUL_STOP_TAG = 'graceful';

/** Grace before SIGKILL for `reason`; `baseSec` (the session spec's grace) applies unless the reason is graceful. */
export function stopGraceForReason(reason: string, baseSec = FAST_STOP_GRACE_SEC): number {
  return reason.includes(GRACEFUL_STOP_TAG) ? Math.max(baseSec, GRACEFUL_STOP_GRACE_SEC) : baseSec;
}
