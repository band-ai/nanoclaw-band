import { describe, it, expect } from 'bun:test';
import { mergeEnv } from './claude.js';

describe('mergeEnv precedence', () => {
  it('later source wins on key collision', () => {
    expect(mergeEnv({ K: 'base' }, { K: 'override' })).toEqual({ K: 'override' });
  });

  it('server.env wins over input.env (simulates per-server env precedence)', () => {
    const inputEnv = { HTTPS_PROXY: 'http://proxy', K: 'from-input' };
    const serverEnv = { K: 'from-server' };
    // mergeEnv(input.env, server.env) — server wins
    expect(mergeEnv(inputEnv, serverEnv)).toMatchObject({ K: 'from-server', HTTPS_PROXY: 'http://proxy' });
  });

  it('drops undefined values', () => {
    expect(mergeEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });
});
