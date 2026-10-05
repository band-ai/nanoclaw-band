/**
 * addExtraMcpServers (Step 3 seam): channel/provider servers delivered via
 * NANOCLAW_EXTRA_MCP_SERVERS, each getting the runner's full container env
 * merged underneath its own.
 */
import { describe, it, expect } from 'bun:test';

import { addExtraMcpServers, fullMcpEnv } from './mcp-servers.js';
import type { McpServerConfig } from './providers/types.js';

function servers(): Record<string, McpServerConfig> {
  return { nanoclaw: { command: 'bun', args: ['run', 'x'], env: { A: '1' } } };
}

describe('addExtraMcpServers', () => {
  it('merges NANOCLAW_EXTRA_MCP_SERVERS and folds the full env under each extra server', () => {
    const result = servers();
    addExtraMcpServers(result, undefined, {
      BAND_REST_URL: 'https://api',
      HTTPS_PROXY: 'http://proxy',
      NANOCLAW_EXTRA_MCP_SERVERS: JSON.stringify({ band: { command: 'thenvoi-mcp', args: [], env: { OWN: 'y' } } }),
    });
    expect(result.nanoclaw).toEqual(servers().nanoclaw);
    const band = result.band;
    expect(band.type === 'http' ? undefined : band.command).toBe('thenvoi-mcp');
    expect(band.type === 'http' ? undefined : band.env).toMatchObject({
      BAND_REST_URL: 'https://api',
      HTTPS_PROXY: 'http://proxy',
      OWN: 'y',
    });
  });

  it("the server's own env wins over the runner env, and extras override earlier entries", () => {
    const result = servers();
    addExtraMcpServers(result, undefined, {
      K: 'from-runner',
      NANOCLAW_EXTRA_MCP_SERVERS: JSON.stringify({ nanoclaw: { command: 'c', args: [], env: { K: 'from-server' } } }),
    });
    const nanoclaw = result.nanoclaw;
    expect(nanoclaw.type === 'http' ? undefined : nanoclaw.command).toBe('c');
    expect(nanoclaw.type === 'http' ? undefined : nanoclaw.env?.K).toBe('from-server');
  });

  it('ignores malformed NANOCLAW_EXTRA_MCP_SERVERS without throwing', () => {
    const result = servers();
    addExtraMcpServers(result, undefined, { NANOCLAW_EXTRA_MCP_SERVERS: 'not json' });
    expect(Object.keys(result)).toEqual(['nanoclaw']);
  });
});

describe('fullMcpEnv', () => {
  it('keeps only string-valued entries', () => {
    expect(fullMcpEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });
});
