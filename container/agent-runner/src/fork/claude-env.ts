/**
 * Fork: Claude provider query environment.
 *
 * - `CLAUDE_CODE_EXECUTABLE` env var overrides the Claude Code binary path
 *   (default `/pnpm/claude`), read once at load.
 * - `QueryInput.env` carries per-query env overrides. They are merged over the
 *   provider env for the SDK and under each stdio MCP server's own env (the
 *   server's env wins); http servers pass through untouched. Undefined values
 *   are dropped.
 */
import type { McpServerConfig } from '../providers/types.js';

declare module '../providers/types.js' {
  interface QueryInput {
    /** Per-query environment overrides, also forwarded to MCP server subprocesses. */
    env?: Record<string, string>;
  }
}

export const CLAUDE_CODE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE || '/pnpm/claude';

/** Later sources win on key collision; undefined values are dropped. */
export function mergeEnv(...sources: Array<Record<string, string | undefined>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/** MCP servers for one query: the query's env folded under each stdio server's own env. */
export function queryMcpServers(
  servers: Record<string, McpServerConfig>,
  input: { env?: Record<string, string> },
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === 'http' ? server : { ...server, env: mergeEnv(input.env ?? {}, server.env ?? {}) },
    ]),
  );
}
