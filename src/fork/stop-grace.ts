/**
 * Fork: stop grace periods for container shutdown. Most kill reasons are
 * recovery paths (stuck claim, absolute ceiling, rebuild) and should not leave
 * the host blocked behind a dying container for minutes. A caller that needs a
 * real shutdown window (e.g. Band.ai memory consolidation) opts in by including
 * "graceful" in its stop reason. See `docker-driver.ts`'s `DockerHandle.stop()`
 * and `host-sweep.ts` / `channels/adapter.ts` (`needsGracefulStopWindow`) for
 * the producing side.
 */
export const FAST_STOP_GRACE_SEC = 10;
export const GRACEFUL_STOP_GRACE_SEC = 30 * 60;

export function stopGraceForReason(reason: string): number {
  return reason.includes('graceful') ? GRACEFUL_STOP_GRACE_SEC : FAST_STOP_GRACE_SEC;
}
