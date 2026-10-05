/**
 * Fork: Compose deployment support. NanoClaw's own host process can run inside a
 * Docker Compose stack (see `docs/docker-compose-deployment.md`), spawning
 * sibling agent containers via the host's Docker socket. Things that differ
 * from the bare-metal case, all no-ops unless the corresponding condition holds:
 *
 *  - `NANOCLAW_DOCKER_NETWORK`: the compose network the agent container must
 *    join to reach the `onecli` service by name (wired into `dockerNetworkArgs`
 *    in `drivers/index.ts`, the seam upstream reserves for network topology).
 *  - `NANOCLAW_ONECLI_HOSTNAME`: OneCLI's injected proxy env vars point at
 *    `host.docker.internal`, which is not reachable/correct from a sibling
 *    container on the compose network — rewritten to the compose service name.
 *  - `NANOCLAW_HOST_PATH`: mount sources are remapped to the real host checkout.
 *  - Host running as root: session/group dirs are chowned to the agent user.
 */
import { execFileSync } from 'child_process';
import path from 'path';

/**
 * Remap a repo-local path back to the real host checkout. When NanoClaw's own
 * process runs inside the Compose container, `process.cwd()` and every mount
 * source it computes point at paths inside ITS OWN container (e.g. `/app`),
 * but the mounts it hands to `docker create` are realized by the Docker
 * daemon on the actual host — which only knows the host filesystem. A no-op
 * unless `NANOCLAW_HOST_PATH` (the absolute host checkout path) is set.
 */
export function toHostPath(
  hostPath: string,
  projectRoot = process.cwd(),
  hostProjectRoot = process.env.NANOCLAW_HOST_PATH,
): string {
  if (!hostProjectRoot) return hostPath;
  const absolutePath = path.resolve(hostPath);
  const absoluteProjectRoot = path.resolve(projectRoot);
  if (absolutePath === absoluteProjectRoot) return hostProjectRoot;
  if (!absolutePath.startsWith(`${absoluteProjectRoot}${path.sep}`)) return hostPath;
  return path.join(hostProjectRoot, path.relative(absoluteProjectRoot, absolutePath));
}

/**
 * Rewrite `host.docker.internal` inside OneCLI's contributed proxy env values
 * to the compose service hostname. A no-op unless `NANOCLAW_ONECLI_HOSTNAME`
 * is set. Only touches `http(s)_proxy`-shaped keys — `NO_PROXY` is a denylist
 * of hosts to bypass, not a gateway address, and rewriting it would exempt
 * onecli from the very no-proxy list it needs to stay reachable outside of.
 */
export function rewriteOneCliProxyEnv(
  env: Record<string, string>,
  hostname = process.env.NANOCLAW_ONECLI_HOSTNAME || undefined,
): Record<string, string> {
  if (!hostname) return env;
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    rewritten[key] = /^https?_proxy$/i.test(key) ? value.replace(/host\.docker\.internal/g, hostname) : value;
  }
  return rewritten;
}

/**
 * The compose deployment runs this host as root (for docker-socket access),
 * so the session/group files it creates are root-owned, while the agent
 * image runs as `node` (uid 1000). On a native-Linux host the agent then
 * cannot write its session DBs — SQLite fails with SQLITE_READONLY and the
 * container dies at startup. (macOS Docker Desktop masks bind-mount
 * ownership, which hides the mismatch.) Align ownership with the agent user
 * before every spawn; non-root hosts are handled by the --user mapping
 * (`SessionSpec.runAs`) instead.
 */
export function alignSessionOwnership(sessDir: string, groupDir: string): void {
  if (process.getuid?.() === 0) {
    execFileSync('chown', ['-R', '1000:1000', sessDir, groupDir]);
  }
}
