/**
 * Fork: MCP server map additions on top of upstream's main() assembly
 * (built-in `nanoclaw` server, then container.json servers via
 * resolvePluginServer).
 *
 * - `fullMcpEnv` is the runner's full container env (string values only). The
 *   built-in `nanoclaw` server receives it so OneCLI proxy vars + channel vars
 *   (BAND_*, etc.) reach its subprocess.
 * - `addExtraMcpServers` then layers channel/provider servers delivered
 *   per-spawn via NANOCLAW_EXTRA_MCP_SERVERS (JSON object; malformed JSON is
 *   ignored) — no container.json mutation. They override earlier entries on name
 *   collision, and each gets the full container env merged underneath its own
 *   env, mirroring what the built-in server receives.
 */
import type { McpServerConfig } from './providers/types.js';

export function fullMcpEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function addExtraMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  log?: (msg: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const mcpEnv = fullMcpEnv(env);
  let extra: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  try {
    extra = JSON.parse(env.NANOCLAW_EXTRA_MCP_SERVERS ?? '{}');
  } catch (err) {
    log?.(`Ignoring malformed NANOCLAW_EXTRA_MCP_SERVERS: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const [name, serverConfig] of Object.entries(extra)) {
    mcpServers[name] = {
      command: serverConfig.command,
      args: serverConfig.args,
      env: { ...mcpEnv, ...(serverConfig.env ?? {}) },
    };
    log?.(`Channel MCP server: ${name} (${serverConfig.command})`);
  }
}
