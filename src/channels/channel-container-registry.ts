import type { MessagingGroup, Session } from '../types.js';
import type { ProviderContainerContribution } from '../providers/provider-container-registry.js';

export interface ChannelContainerContext {
  session: Session;
  messagingGroup: MessagingGroup | null;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type ChannelContainerConfigFn = (
  ctx: ChannelContainerContext,
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;

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
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;

const agentRegistry: AgentContainerConfigFn[] = [];

export function registerAgentContainerConfig(fn: AgentContainerConfigFn): void {
  agentRegistry.push(fn);
}

export function getAgentContainerConfigs(): AgentContainerConfigFn[] {
  return [...agentRegistry];
}
