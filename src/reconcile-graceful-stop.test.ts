/**
 * Fork regression test: the graceful-stop tag on absolute-ceiling kills.
 *
 * `stopGraceForReason` (container-runtime.ts) grants GRACEFUL_STOP_GRACE_SEC
 * (30 min) instead of FAST_STOP_GRACE_SEC (10 s) only when the kill reason
 * contains 'graceful'. The producer of that tag is enforceRunningContainerSla,
 * which asks sessionNeedsGracefulStop whether the adapter handling the
 * session's messaging group declared `needsGracefulStop`. Band depends on it to
 * consolidate memory before the container dies.
 *
 * The CONSUMER side is pinned by container-runner.test.ts
 * (`describe('stopGraceForReason')`). This pins the PRODUCER, which upstream
 * does not have and which has already moved module once — host-sweep.ts →
 * reconcile-session.ts, during the 294ef2ae→858421af sync, when upstream
 * extracted the sweep into the reconcile-* modules. That relocation was
 * invisible to every existing test: nothing asserted the tag is emitted.
 *
 * Goes red if an upstream refactor drops the tag or the adapter lookup. The
 * failure mode without this test is silent — the code still compiles, the
 * container still dies, it just dies in 10 seconds and loses Band's memory.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-reconcile-graceful' };
});

// The container is "running" and its start time is well past the 30-minute
// absolute ceiling, so decideStuckAction returns kill-ceiling on the first pass.
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now() - 60 * 60 * 1000),
  isContainerRunning: vi.fn(() => true),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { killContainer } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { createSession } from './db/sessions.js';
import { reconcileSession } from './reconcile-session.js';
import { initSessionFolder } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-reconcile-graceful';
const AG = 'ag-graceful';
const SESS = 'sess-graceful';
const MG = 'mg-graceful';

/** Minimal adapter; `needsGracefulStop` is the only field under test. */
function fakeAdapter(channelType: string, needsGracefulStop?: boolean): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    ...(needsGracefulStop === undefined ? {} : { needsGracefulStop }),
    async setup(_config: ChannelSetup) {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
  };
}

/**
 * Register one adapter, bring it online through the real boot path, and wire a
 * ceiling-eligible running session to a messaging group on that channel.
 */
async function arrange(channelType: string, needsGracefulStop?: boolean): Promise<void> {
  registerChannelAdapter(channelType, { factory: () => fakeAdapter(channelType, needsGracefulStop) });
  await initChannelAdapters((adapter) => ({ channelType: adapter.channelType }) as unknown as ChannelSetup);

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Graceful',
    folder: 'graceful',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: MG,
    channel_type: channelType,
    platform_id: `${channelType}:room-1`,
    // Omitted → createMessagingGroup defaults the instance to channel_type,
    // which is the key sessionNeedsGracefulStop resolves the adapter by.
    instance: undefined,
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: MG,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initSessionFolder(AG, SESS);
}

beforeEach(() => {
  vi.mocked(killContainer).mockReset();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('absolute-ceiling kill reason carries the graceful tag', () => {
  it("tags the kill 'graceful' when the session's adapter declares needsGracefulStop", async () => {
    await arrange('band-like', true);

    await reconcileSession(SESS);

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'absolute-ceiling graceful');
  });

  it('leaves the reason plain when the adapter does not declare it', async () => {
    await arrange('plain-channel', undefined);

    await reconcileSession(SESS);

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'absolute-ceiling');
  });

  it('leaves the reason plain when the adapter explicitly opts out', async () => {
    await arrange('opted-out', false);

    await reconcileSession(SESS);

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'absolute-ceiling');
  });
});
