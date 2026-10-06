/**
 * Fork regression test: the CONSUMER side of the graceful-stop tag.
 *
 * `absoluteCeilingStopReason` (src/fork/graceful-stop.ts) tags a ceiling kill
 * 'graceful' for adapters that need a shutdown window (Band memory
 * consolidation). The tag only matters if `DockerHandle.stop()` turns it into
 * a long `docker stop -t`. Upstream's driver seam reads a fixed spec grace, so
 * a sync that rewrites `stop()` silently drops the window: everything still
 * compiles and the producer test stays green, but the container dies in
 * seconds. This pins the consumer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GRACEFUL_STOP_GRACE_SEC } from '../fork/stop-grace.js';
import { DockerSessionDriver } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

let cli: FakeCli;

beforeEach(() => {
  cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
});

async function stopWith(reason: string): Promise<string[]> {
  const handle = await new DockerSessionDriver({ ...FIXTURE_POLICY, cli }).prepare(fixtureSpec());
  await handle.start();
  await handle.stop(reason);
  return cli.joined();
}

describe('DockerHandle.stop grace', () => {
  it('grants the long window to a graceful stop reason', async () => {
    expect(await stopWith('absolute-ceiling graceful')).toContain(`stop -t ${GRACEFUL_STOP_GRACE_SEC} ncl-spike-s1`);
  });

  it('keeps every other reason on the spec grace', async () => {
    expect(await stopWith('absolute-ceiling')).toContain('stop -t 1 ncl-spike-s1');
  });
});
