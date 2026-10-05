import { describe, it, expect } from 'bun:test';

import { mergeEnv, queryMcpServers } from './claude-env.js';

describe('mergeEnv precedence', () => {
  it('later source wins on key collision', () => {
    expect(mergeEnv({ K: 'base' }, { K: 'override' })).toEqual({ K: 'override' });
  });

  it('drops undefined values', () => {
    expect(mergeEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });
});

describe('queryMcpServers', () => {
  it("folds the query env under each stdio server's own env and leaves http servers untouched", () => {
    const http = { type: 'http' as const, url: 'https://mcp.example.com/mcp' };
    const servers = queryMcpServers(
      { stdio: { command: 'c', env: { K: 'from-server' } }, http },
      { env: { HTTPS_PROXY: 'http://proxy', K: 'from-input' } },
    );
    expect(servers.stdio).toEqual({ command: 'c', env: { HTTPS_PROXY: 'http://proxy', K: 'from-server' } });
    expect(servers.http).toBe(http);
  });
});
