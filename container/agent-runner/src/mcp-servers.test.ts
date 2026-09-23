/**
 * extendMcpServers (Step 3 seam): applied after upstream's inline map, it gives
 * the built-in server the runner env and adds NANOCLAW_EXTRA_MCP_SERVERS
 * servers, each with the runner env merged underneath its own.
 */
import { describe, it, expect } from 'bun:test';

import { extendMcpServers } from './mcp-servers.js';
import { resolvePluginServer } from './plugin-mcp.js';
import type { McpServerConfig } from './providers/types.js';

/** Mirrors upstream's inline block in index.ts main(), then applies the fork helper. */
function build(
  configServers: Record<string, McpServerConfig>,
  env: Record<string, string | undefined>,
): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: { command: 'bun', args: ['run', 'x'], env: {} },
  };
  for (const [name, serverConfig] of Object.entries(configServers)) {
    mcpServers[name] = resolvePluginServer(serverConfig);
  }
  extendMcpServers(mcpServers, { configServers, env });
  return mcpServers;
}

const runnerEnv = { BAND_REST_URL: 'https://api', HTTPS_PROXY: 'http://proxy', UNSET: undefined };

describe('extendMcpServers', () => {
  it('gives the built-in nanoclaw server the runner env, dropping undefined values', () => {
    const result = build({}, runnerEnv);
    expect(result.nanoclaw).toEqual({
      command: 'bun',
      args: ['run', 'x'],
      env: { BAND_REST_URL: 'https://api', HTTPS_PROXY: 'http://proxy' },
    });
  });

  it('leaves a container.json server that replaces nanoclaw exactly as configured', () => {
    const result = build({ nanoclaw: { command: 'custom', args: [], env: { OWN: '1' } } }, runnerEnv);
    expect(result.nanoclaw).toEqual({ command: 'custom', args: [], env: { OWN: '1' } });
  });

  it('does not fold the runner env into container.json servers', () => {
    const result = build(
      {
        foo: { command: 'foo-cmd', args: ['--x'], env: { F: '1' } },
        remote: { type: 'http', url: 'https://mcp.example' },
      },
      runnerEnv,
    );
    expect(result.foo).toEqual({ command: 'foo-cmd', args: ['--x'], env: { F: '1' } });
    expect(result.remote).toEqual({ type: 'http', url: 'https://mcp.example' });
  });

  it('adds extra servers with the runner env under their own env, own env winning', () => {
    const result = build(
      {},
      {
        ...runnerEnv,
        HTTPS_PROXY: 'from-runner',
        NANOCLAW_EXTRA_MCP_SERVERS: JSON.stringify({
          band: { command: 'thenvoi-mcp', args: ['--y'], env: { HTTPS_PROXY: 'from-server' } },
        }),
      },
    );
    expect(result.band).toEqual({
      command: 'thenvoi-mcp',
      args: ['--y'],
      env: {
        BAND_REST_URL: 'https://api',
        HTTPS_PROXY: 'from-server',
        NANOCLAW_EXTRA_MCP_SERVERS: expect.any(String),
      },
    });
  });

  it('lets an extra server override a same-named container.json server and the built-in', () => {
    const result = build(
      { band: { type: 'http', url: 'https://mcp.example' } },
      {
        NANOCLAW_EXTRA_MCP_SERVERS: JSON.stringify({
          band: { command: 'extra-band', args: [] },
          nanoclaw: { command: 'extra-nanoclaw', args: [] },
        }),
      },
    );
    expect(result.band).toEqual({ command: 'extra-band', args: [], env: expect.any(Object) });
    expect(result.nanoclaw).toEqual({ command: 'extra-nanoclaw', args: [], env: expect.any(Object) });
  });

  it('ignores malformed NANOCLAW_EXTRA_MCP_SERVERS without throwing', () => {
    const result = build({}, { NANOCLAW_EXTRA_MCP_SERVERS: 'not json' });
    expect(Object.keys(result)).toEqual(['nanoclaw']);
    expect(result.nanoclaw).toEqual({
      command: 'bun',
      args: ['run', 'x'],
      env: { NANOCLAW_EXTRA_MCP_SERVERS: 'not json' },
    });
  });
});
