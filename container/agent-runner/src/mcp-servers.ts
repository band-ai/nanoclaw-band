/**
 * MCP server map assembly.
 *
 * Combines three sources, later sources overriding earlier on name collision:
 *   1. the built-in `nanoclaw` server (passed in by the caller),
 *   2. servers declared in container.json (`config.mcpServers`),
 *   3. channel/provider servers delivered per-spawn via the
 *      NANOCLAW_EXTRA_MCP_SERVERS env var (Step 3 seam — no container.json
 *      mutation). Each gets the runner's full container env merged underneath
 *      its own env, mirroring what the built-in `nanoclaw` server receives, so
 *      OneCLI proxy vars + channel vars (BAND_*, etc.) reach the subprocess.
 *
 * Pure and side-effect free apart from the optional `log` callback, so the
 * merge is unit-testable without standing up `main()`.
 */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildMcpServersInput {
  /** The built-in nanoclaw server entry (already constructed by the caller). */
  builtin: Record<string, McpServerSpec>;
  /** Servers from container.json (config.mcpServers). */
  configServers: Record<string, McpServerSpec>;
  /** Full container env to merge under each extra server's own env. */
  mcpEnv: Record<string, string>;
  /** Raw NANOCLAW_EXTRA_MCP_SERVERS value (JSON object), or undefined. */
  extraMcpJson: string | undefined;
  log?: (msg: string) => void;
}

export function buildMcpServers(input: BuildMcpServersInput): Record<string, McpServerSpec> {
  const { builtin, configServers, mcpEnv, extraMcpJson, log } = input;

  const mcpServers: Record<string, McpServerSpec> = { ...builtin };

  for (const [name, serverConfig] of Object.entries(configServers)) {
    mcpServers[name] = serverConfig;
    log?.(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const extra = ((): Record<string, { command: string; args: string[]; env?: Record<string, string> }> => {
    try {
      return JSON.parse(extraMcpJson ?? '{}') as Record<
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

  return mcpServers;
}
