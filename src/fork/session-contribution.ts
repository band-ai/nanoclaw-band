/**
 * Fork: channel- and agent-scoped container contributions, layered over the
 * provider's contribution at spawn. Kept out of `resolveProviderContribution`
 * so upstream's provider path stays untouched; `container-runner.ts` calls in
 * here from a handful of one-line hooks.
 */
import { getAgentContainerConfigs, getChannelContainerConfig } from '../channels/channel-container-registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../types.js';
import { toHostPath } from './compose-deployment.js';

/** A single MCP server contributed by a channel or provider. */
export interface McpServerContribution {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

declare module '../providers/provider-container-registry.js' {
  interface ProviderContainerContribution {
    /**
     * Extra MCP servers to pass into the container via NANOCLAW_EXTRA_MCP_SERVERS.
     * Later contributions override earlier on name collision. Spawn merges
     * provider → channel → agent-scoped (resolveSessionContribution +
     * mergeContainerContributions), so on a name clash agent-scoped wins over
     * channel, and channel wins over provider (same precedence as `env`).
     */
    mcpServers?: Record<string, McpServerContribution>;
    /**
     * Tool names the agent should treat as user-visible (shown in typing/progress UI).
     * Concatenated across all contributions.
     */
    userVisibleTools?: string[];
  }
}

/**
 * Channel- and agent-scoped container contributions for a session.
 * Channel contributions come from the session's messaging group; agent-scoped
 * ones apply to every session of the group regardless of channel (e.g. Band
 * grants cross-channel control tools).
 */
export async function resolveSessionContribution(
  session: Session,
  agentGroup: AgentGroup,
): Promise<ProviderContainerContribution> {
  const messagingGroup = session.messaging_group_id
    ? ((await getMessagingGroup(session.messaging_group_id)) ?? null)
    : null;
  const channelFn = messagingGroup ? getChannelContainerConfig(messagingGroup.channel_type) : undefined;
  const channelContribution = channelFn
    ? await channelFn({
        session,
        messagingGroup,
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};

  const agentContributions = await Promise.all(
    getAgentContainerConfigs().map(async (fn) => fn({ session, agentGroupId: agentGroup.id, hostEnv: process.env })),
  );

  return mergeContainerContributions(channelContribution, ...agentContributions);
}

/**
 * Merge contributions in precedence order (later wins for `env` and
 * `mcpServers`; `mounts` and `userVisibleTools` concatenate).
 */
export function mergeContainerContributions(
  ...contributions: ProviderContainerContribution[]
): ProviderContainerContribution {
  return {
    mounts: contributions.flatMap((c) => c.mounts ?? []),
    env: Object.assign({}, ...contributions.map((c) => c.env ?? {})),
    mcpServers: Object.assign({}, ...contributions.map((c) => c.mcpServers ?? {})),
    userVisibleTools: contributions.flatMap((c) => c.userVisibleTools ?? []),
  };
}

/**
 * Finish the spawn's mount list, in place, right after `buildMounts`:
 *
 *  - Channel/agent-scoped mounts are appended last. A provider contract never
 *    covers these, so they apply whether or not one is declared. Same
 *    'allowlisted-extra' vetting as provider mounts — the contributor is
 *    in-tree registration.
 *  - Compose deployment: every mount source is remapped to the real host
 *    checkout (`toHostPath`). No-op unless NANOCLAW_HOST_PATH is set.
 */
export function applySessionMounts(
  mounts: VolumeMount[],
  sessionMounts: VolumeMount[] | undefined,
  scope: string,
  projectRoot = process.cwd(),
): void {
  if (sessionMounts?.length) {
    mounts.push(...sessionMounts.map((m) => ({ ...m, mountClass: 'allowlisted-extra' as const, scope })));
  }
  const remapped = mounts.map((mount) => ({ ...mount, hostPath: toHostPath(mount.hostPath, projectRoot) }));
  mounts.splice(0, mounts.length, ...remapped);
}

/**
 * Contributed-env entries for the fork-only contribution fields, layered onto
 * `composeSessionSpec`'s contributed lane after provider + gateway env.
 * Empty stays absent so the container sees no extra servers/tools rather than
 * an empty value.
 */
export function forkContributionEnv(contribution: ProviderContainerContribution): Record<string, string> {
  const env: Record<string, string> = {};
  // Picked up by buildMcpServers() in the container's main().
  if (contribution.mcpServers && Object.keys(contribution.mcpServers).length > 0) {
    env.NANOCLAW_EXTRA_MCP_SERVERS = JSON.stringify(contribution.mcpServers);
  }
  // User-visible tool names seeded into the container at startup.
  if (contribution.userVisibleTools && contribution.userVisibleTools.length > 0) {
    env.NANOCLAW_USER_VISIBLE_TOOLS = JSON.stringify(contribution.userVisibleTools);
  }
  return env;
}
