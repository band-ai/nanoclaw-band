import { getMessagingGroup } from '../db/messaging-groups.js';
import type { AgentGroup, MessagingGroup, Session } from '../types.js';
import type { ProviderContainerContribution } from '../providers/provider-container-registry.js';

/**
 * What a channel or agent-scoped registration may contribute to a session's
 * container. Mounts are provider-only: they are validated and realized by
 * `buildMounts`, which sees only the provider's contribution.
 */
export type ForkContainerContribution = Pick<ProviderContainerContribution, 'env' | 'mcpServers' | 'userVisibleTools'>;

export interface ChannelContainerContext {
  session: Session;
  messagingGroup: MessagingGroup | null;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type ChannelContainerConfigFn = (
  ctx: ChannelContainerContext,
) => ForkContainerContribution | Promise<ForkContainerContribution>;

const registry = new Map<string, ChannelContainerConfigFn>();

export function registerChannelContainerConfig(channelType: string, fn: ChannelContainerConfigFn): void {
  if (registry.has(channelType)) {
    throw new Error(`Channel container config already registered: ${channelType}`);
  }
  registry.set(channelType, fn);
}

export function getChannelContainerConfig(channelType: string): ChannelContainerConfigFn | undefined {
  return registry.get(channelType);
}

export function listChannelContainerConfigNames(): string[] {
  return [...registry.keys()];
}

/**
 * Agent-scoped container contributions — applied to EVERY session of an agent
 * group regardless of the session's channel, so a channel can grant the agent
 * cross-channel control tools (e.g. Band peer/room management from a Telegram
 * session). The producer decides whether it applies to a given agent group and
 * returns {} otherwise.
 */
export interface AgentContainerContext {
  session: Session;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type AgentContainerConfigFn = (
  ctx: AgentContainerContext,
) => ForkContainerContribution | Promise<ForkContainerContribution>;

const agentRegistry: AgentContainerConfigFn[] = [];

export function registerAgentContainerConfig(fn: AgentContainerConfigFn): void {
  agentRegistry.push(fn);
}

export function getAgentContainerConfigs(): AgentContainerConfigFn[] {
  return [...agentRegistry];
}

/**
 * Resolve the fork's channel- and agent-scoped contributions for a session,
 * layered channel < agent (later wins on env/mcpServers name collisions;
 * userVisibleTools concatenate in that order).
 */
export async function resolveForkContainerContribution(
  session: Session,
  agentGroup: AgentGroup,
): Promise<ForkContainerContribution> {
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

  // Agent-scoped contributions apply to every session of the group regardless
  // of the session's channel (e.g. Band grants cross-channel control tools).
  const agentContributions = await Promise.all(
    getAgentContainerConfigs().map((fn) => fn({ session, agentGroupId: agentGroup.id, hostEnv: process.env })),
  );

  const contributions = [channelContribution, ...agentContributions];
  return {
    env: Object.assign({}, ...contributions.map((c) => c.env ?? {})),
    mcpServers: Object.assign({}, ...contributions.map((c) => c.mcpServers ?? {})),
    userVisibleTools: contributions.flatMap((c) => c.userVisibleTools ?? []),
  };
}

/**
 * Layer the fork's contribution over the provider's: env/mcpServers resolve
 * provider < fork, userVisibleTools concatenate provider-first, and mounts
 * come only from the provider.
 */
export function mergeContainerContributions(
  provider: ProviderContainerContribution,
  fork: ForkContainerContribution,
): ProviderContainerContribution {
  return {
    mounts: provider.mounts ?? [],
    env: Object.assign({}, provider.env, fork.env),
    mcpServers: Object.assign({}, provider.mcpServers, fork.mcpServers),
    userVisibleTools: [...(provider.userVisibleTools ?? []), ...(fork.userVisibleTools ?? [])],
  };
}
