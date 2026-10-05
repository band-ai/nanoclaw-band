import { describe, expect, it } from 'vitest';

import { rewriteOneCliProxyEnv } from './compose-deployment.js';

describe('rewriteOneCliProxyEnv', () => {
  it('rewrites OneCLI proxy host env for compose child containers', () => {
    const env = {
      HTTPS_PROXY: 'http://x:token@host.docker.internal:10255',
      NO_PROXY: 'localhost,host.docker.internal',
    };

    const rewritten = rewriteOneCliProxyEnv(env, 'onecli');

    expect(rewritten.HTTPS_PROXY).toBe('http://x:token@onecli:10255');
    // Only *_proxy-shaped keys are touched — NO_PROXY is a denylist, not a
    // gateway address, and rewriting it would exempt onecli from the very
    // no-proxy list it is supposed to be reachable outside of.
    expect(rewritten.NO_PROXY).toBe('localhost,host.docker.internal');
  });

  it('leaves env unchanged without a compose hostname', () => {
    const env = { HTTPS_PROXY: 'http://x:token@host.docker.internal:10255' };

    expect(rewriteOneCliProxyEnv(env, undefined)).toEqual(env);
  });
});
