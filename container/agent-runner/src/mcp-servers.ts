/**
 * Fork additions to the MCP server map that upstream's main() builds inline.
 *
 * main() first assembles upstream's map verbatim: the built-in `nanoclaw`
 * server (empty env) plus the container.json servers (`config.mcpServers`,
 * each passed through `resolvePluginServer`). It then calls
 * `extendMcpServers`, which applies the fork's two additions in place:
 *
 *   1. the built-in `nanoclaw` server receives the runner's full container
 *      env — unless container.json replaced it with its own `nanoclaw`
 *      server, which then stays exactly as configured;
 *   2. channel/provider servers delivered per-spawn via the
 *      NANOCLAW_EXTRA_MCP_SERVERS env var (Step 3 seam — no container.json
 *      mutation) are added, overriding any same-named server. Each gets the
 *      runner's full container env merged underneath its own env, so OneCLI
 *      proxy vars + channel vars (BAND_*, etc.) reach the subprocess.
 *      Malformed JSON adds nothing.
 *
 * Keeping these additions out of upstream's block leaves upstream's lines
 * untouched in index.ts, so upstream merges don't conflict here.
 */
import type { McpServerConfig } from './providers/types.js';

export interface ExtendMcpServersInput {
  /** The container.json servers upstream's block already merged (config.mcpServers). */
  configServers: Record<string, McpServerConfig>;
  /** The runner's container env (process.env); NANOCLAW_EXTRA_MCP_SERVERS is read from it. */
  env: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export function extendMcpServers(mcpServers: Record<string, McpServerConfig>, input: ExtendMcpServersInput): void {
  const { configServers, env, log } = input;

  const mcpEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  const builtin = mcpServers.nanoclaw;
  if (!Object.keys(configServers).includes('nanoclaw') && builtin && builtin.type !== 'http') {
    builtin.env = mcpEnv;
  }

  const extra = ((): Record<string, { command: string; args: string[]; env?: Record<string, string> }> => {
    try {
      return JSON.parse(env.NANOCLAW_EXTRA_MCP_SERVERS ?? '{}') as Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    } catch {
      return {};
    }
  })();

  for (const [name, serverConfig] of Object.entries(extra)) {
    mcpServers[name] = {
      command: serverConfig.command,
      args: serverConfig.args,
      env: { ...mcpEnv, ...(serverConfig.env ?? {}) },
    };
    log?.(`Channel MCP server: ${name} (${serverConfig.command})`);
  }
}
