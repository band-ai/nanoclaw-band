/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Stop grace periods for container shutdown. Most kill reasons are recovery
 * paths (stuck claim, absolute ceiling, rebuild) and should not leave the host
 * blocked behind a dying container for minutes. A caller that needs a real
 * shutdown window (e.g. Band.ai memory consolidation) opts in by including
 * "graceful" in its stop reason. See `docker-driver.ts`'s `DockerHandle.stop()`
 * and `host-sweep.ts` / `channels/adapter.ts` (`needsGracefulStopWindow`) for
 * the producing side.
 */
export const FAST_STOP_GRACE_SEC = 10;
export const GRACEFUL_STOP_GRACE_SEC = 30 * 60;

export function stopGraceForReason(reason: string): number {
  return reason.includes('graceful') ? GRACEFUL_STOP_GRACE_SEC : FAST_STOP_GRACE_SEC;
}
