// Behavior tests for /add-band's register-agent.sh (vendored byte-for-byte from
// band-ai/add-band scripts/register-agent.sh). The script runs against a stub
// `curl` on PATH that records the request — the X-API-Key header it reads from
// its `-K -` stdin config and the JSON body passed with `-d` — and answers 201
// with an agent id + key. The child runs in its own session with no controlling
// terminal, so the script takes its non-interactive path (no /dev/tty prompts).
//
// Contract under test:
//   - BAND_USER_API_KEY wins over BAND_API_KEY when both are set (a stale
//     agent-scoped BAND_API_KEY in the shell must not hijack registration);
//     BAND_API_KEY alone still works;
//   - with no --name / BAND_AGENT_NAME, the default agent name differs between
//     runs (Band names are unique per owner, so a fixed default 422s on the
//     second install).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../.claude/skills/add-band/scripts/register-agent.sh');

let dir: string;
let bin: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band-register-'));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Each call appends one JSON line: the header config from stdin + the -d body.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
body=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then body="$2"; shift; fi
  shift
done
header=$(cat)
printf '%s\\n%s\\n' "$header" "$body" >> "${dir}/requests"
printf '{"data":{"agent":{"id":"agent-1"},"credentials":{"api_key":"band_a_agent"}}}\\n201'
`,
    { mode: 0o755 },
  );
  // Advances one second per call, so consecutive runs see different clocks.
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
n=$(cat "${dir}/clock" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/clock"
printf '20261006-1200%02d\\n' "$n"
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function register(env: Record<string, string>): Promise<{ status: number | null; stdout: string }> {
  const child = spawn('bash', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
    // New session, no controlling terminal: the script must not prompt.
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, stdout };
}

function requests(): Array<{ header: string; name: string }> {
  const lines = fs.readFileSync(path.join(dir, 'requests'), 'utf8').trimEnd().split('\n');
  const out: Array<{ header: string; name: string }> = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push({ header: lines[i], name: JSON.parse(lines[i + 1]).agent.name });
  }
  return out;
}

describe('add-band register-agent.sh', () => {
  it('uses BAND_USER_API_KEY over a stale BAND_API_KEY', async () => {
    const res = await register({ BAND_USER_API_KEY: 'band_u_user', BAND_API_KEY: 'band_a_stale' });

    expect(res.status).toBe(0);
    expect(requests()[0].header).toBe('header = "X-API-Key: band_u_user"');
    expect(res.stdout).toBe('BAND_AGENT_ID=agent-1\nBAND_AGENT_API_KEY=band_a_agent\n');
  });

  it('falls back to BAND_API_KEY when BAND_USER_API_KEY is unset', async () => {
    const res = await register({ BAND_API_KEY: 'band_u_only' });

    expect(res.status).toBe(0);
    expect(requests()[0].header).toBe('header = "X-API-Key: band_u_only"');
  });

  it('gives each run a different default agent name', async () => {
    expect((await register({ BAND_USER_API_KEY: 'band_u_user' })).status).toBe(0);
    expect((await register({ BAND_USER_API_KEY: 'band_u_user' })).status).toBe(0);

    const [first, second] = requests().map((r) => r.name);
    expect(first).not.toBe(second);
    expect(first).not.toBe('Band agent');
  });

  it('keeps an explicit BAND_AGENT_NAME', async () => {
    await register({ BAND_USER_API_KEY: 'band_u_user', BAND_AGENT_NAME: 'Weather Agent' });

    expect(requests()[0].name).toBe('Weather Agent');
  });
});
