/**
 * buildMcpServers merge (Step 3 seam): container.json servers + channel/provider
 * servers delivered via NANOCLAW_EXTRA_MCP_SERVERS, each getting the runner's
 * full container env merged underneath its own.
 */
import { describe, it, expect } from 'bun:test';

import { buildMcpServers } from './mcp-servers.js';

const builtin = { nanoclaw: { command: 'bun', args: ['run', 'x'], env: { A: '1' } } };

describe('buildMcpServers', () => {
  it('keeps the builtin server and adds container.json servers', () => {
    const result = buildMcpServers({
      builtin,
      configServers: { foo: { command: 'foo-cmd', args: ['--x'], env: { F: '1' } } },
      mcpEnv: { BAND_REST_URL: 'https://api', HTTPS_PROXY: 'http://proxy' },
      extraMcpJson: undefined,
    });
    expect(result.nanoclaw).toBeDefined();
    expect(result.foo.command).toBe('foo-cmd');
  });

  it('merges NANOCLAW_EXTRA_MCP_SERVERS and folds mcpEnv under each extra server', () => {
    const result = buildMcpServers({
      builtin,
      configServers: {},
      mcpEnv: { BAND_REST_URL: 'https://api', HTTPS_PROXY: 'http://proxy' },
      extraMcpJson: JSON.stringify({ band: { command: 'thenvoi-mcp', args: [], env: { OWN: 'y' } } }),
    });
    expect(result.band.command).toBe('thenvoi-mcp');
    // runner env merged underneath the server's own env
    expect(result.band.env.BAND_REST_URL).toBe('https://api');
    expect(result.band.env.HTTPS_PROXY).toBe('http://proxy');
    expect(result.band.env.OWN).toBe('y');
  });

  it("the server's own env wins over mcpEnv on key collision", () => {
    const result = buildMcpServers({
      builtin,
      configServers: {},
      mcpEnv: { K: 'from-runner' },
      extraMcpJson: JSON.stringify({ band: { command: 'c', args: [], env: { K: 'from-server' } } }),
    });
    expect(result.band.env.K).toBe('from-server');
  });

  it('ignores malformed NANOCLAW_EXTRA_MCP_SERVERS without throwing', () => {
    const result = buildMcpServers({
      builtin,
      configServers: {},
      mcpEnv: {},
      extraMcpJson: 'not json',
    });
    expect(Object.keys(result)).toEqual(['nanoclaw']);
  });
});
