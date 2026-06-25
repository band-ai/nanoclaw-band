import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  resolveProviderName,
  rewriteOneCliProxyArgs,
  stopGraceForReason,
  FAST_STOP_GRACE_SEC,
  GRACEFUL_STOP_GRACE_SEC,
} from './container-runner.js';

describe('stopGraceForReason', () => {
  it('grants the long graceful window when the reason contains "graceful"', () => {
    expect(stopGraceForReason('absolute-ceiling graceful')).toBe(GRACEFUL_STOP_GRACE_SEC);
  });

  it('keeps recovery/stuck kills on the fast window', () => {
    expect(stopGraceForReason('absolute-ceiling')).toBe(FAST_STOP_GRACE_SEC);
    expect(stopGraceForReason('claim-stuck')).toBe(FAST_STOP_GRACE_SEC);
    expect(stopGraceForReason('rebuild applied')).toBe(FAST_STOP_GRACE_SEC);
  });
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('rewriteOneCliProxyArgs', () => {
  it('rewrites OneCLI proxy host args for compose child containers', () => {
    const args = [
      'run',
      '-e',
      'HTTPS_PROXY=http://x:token@host.docker.internal:10255',
      '-e',
      'NO_PROXY=localhost,host.docker.internal',
      '--add-host=host.docker.internal:host-gateway',
    ];

    rewriteOneCliProxyArgs(args, 'onecli');

    expect(args).toContain('HTTPS_PROXY=http://x:token@onecli:10255');
    expect(args).toContain('NO_PROXY=localhost,host.docker.internal');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('leaves args unchanged without a compose hostname', () => {
    const args = ['-e', 'HTTPS_PROXY=http://x:token@host.docker.internal:10255'];

    rewriteOneCliProxyArgs(args, undefined);

    expect(args).toEqual(['-e', 'HTTPS_PROXY=http://x:token@host.docker.internal:10255']);
  });
});
