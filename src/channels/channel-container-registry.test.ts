import { describe, expect, it, vi } from 'vitest';

import {
  getChannelContainerConfig,
  listChannelContainerConfigNames,
  mergeContainerContributions,
  registerAgentContainerConfig,
  registerChannelContainerConfig,
  resolveForkContainerContribution,
} from './channel-container-registry.js';
import type { AgentGroup, MessagingGroup, Session } from '../types.js';

const { getMessagingGroupMock } = vi.hoisted(() => ({ getMessagingGroupMock: vi.fn() }));
vi.mock('../db/messaging-groups.js', () => ({ getMessagingGroup: getMessagingGroupMock }));

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function messagingGroup(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'fake-channel-container',
    platform_id: 'fake:room-1',
    name: 'Fake Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  };
}

describe('channel container registry', () => {
  it('registers session-aware channel container contributions', async () => {
    registerChannelContainerConfig('fake-channel-container', (ctx) => ({
      env: {
        CHANNEL_TYPE: ctx.messagingGroup?.channel_type ?? '',
        PLATFORM_ID: ctx.messagingGroup?.platform_id ?? '',
        AGENT_GROUP_ID: ctx.agentGroupId,
        SESSION_ID: ctx.session.id,
      },
    }));

    const fn = getChannelContainerConfig('fake-channel-container');
    expect(fn).toBeDefined();
    const contribution = await fn!({
      session: session(),
      messagingGroup: messagingGroup(),
      agentGroupId: 'ag-1',
      hostEnv: {},
    });

    expect(contribution.env).toEqual({
      CHANNEL_TYPE: 'fake-channel-container',
      PLATFORM_ID: 'fake:room-1',
      AGENT_GROUP_ID: 'ag-1',
      SESSION_ID: 'sess-1',
    });
    expect(listChannelContainerConfigNames()).toContain('fake-channel-container');
  });

  it('rejects duplicate registrations', () => {
    registerChannelContainerConfig('duplicate-channel-container', () => ({}));
    expect(() => registerChannelContainerConfig('duplicate-channel-container', () => ({}))).toThrow(
      'Channel container config already registered',
    );
  });
});

describe('mergeContainerContributions', () => {
  it('round-trips a fork contribution over an empty provider contribution', () => {
    const merged = mergeContainerContributions(
      {},
      {
        env: { BAND_REST_URL: 'https://api' },
        mcpServers: { band: { command: 'thenvoi-mcp', args: [], env: {} } },
        userVisibleTools: ['mcp__nanoclaw__band_send_message'],
      },
    );
    expect(merged.mcpServers).toEqual({ band: { command: 'thenvoi-mcp', args: [], env: {} } });
    expect(merged.userVisibleTools).toEqual(['mcp__nanoclaw__band_send_message']);
    expect(merged.env).toEqual({ BAND_REST_URL: 'https://api' });
  });

  it('layers the fork over the provider and keeps provider mounts', () => {
    const mount = { hostPath: '/host/provider', containerPath: '/provider', readonly: true };
    const merged = mergeContainerContributions(
      {
        mounts: [mount],
        env: { SHARED: 'provider', PROVIDER_ONLY: 'p' },
        mcpServers: { shared: { command: 'provider', args: [] }, a: { command: 'a', args: [] } },
        userVisibleTools: ['mcp__nanoclaw__send_message'],
      },
      {
        env: { SHARED: 'fork' },
        mcpServers: { shared: { command: 'fork', args: [] }, b: { command: 'b', args: [] } },
        userVisibleTools: ['mcp__nanoclaw__band_send_message'],
      },
    );
    expect(merged.mounts).toEqual([mount]);
    expect(merged.env).toEqual({ SHARED: 'fork', PROVIDER_ONLY: 'p' });
    expect(merged.mcpServers).toEqual({
      shared: { command: 'fork', args: [] },
      a: { command: 'a', args: [] },
      b: { command: 'b', args: [] },
    });
    expect(merged.userVisibleTools).toEqual(['mcp__nanoclaw__send_message', 'mcp__nanoclaw__band_send_message']);
  });
});

describe('resolveForkContainerContribution', () => {
  it('layers agent-scoped contributions over the session channel, in registration order', async () => {
    const group = { ...messagingGroup(), channel_type: 'fork-layering-channel' };
    getMessagingGroupMock.mockResolvedValue(group);
    const seen: { messagingGroup: MessagingGroup | null; agentGroupId: string }[] = [];
    registerChannelContainerConfig('fork-layering-channel', (ctx) => {
      seen.push({ messagingGroup: ctx.messagingGroup, agentGroupId: ctx.agentGroupId });
      return {
        env: { SHARED: 'channel', CHANNEL_ONLY: 'c' },
        mcpServers: { shared: { command: 'channel', args: [] } },
        userVisibleTools: ['channel_tool'],
      };
    });
    registerAgentContainerConfig(async (ctx) => ({
      env: { SHARED: 'agent-1', AGENT_SHARED: 'agent-1', AGENT_GROUP: ctx.agentGroupId },
      mcpServers: { shared: { command: 'agent-1', args: [] } },
      userVisibleTools: ['agent_1_tool'],
    }));
    registerAgentContainerConfig(() => ({ env: { AGENT_SHARED: 'agent-2' }, userVisibleTools: ['agent_2_tool'] }));

    const resolved = await resolveForkContainerContribution(session(), { id: 'ag-1' } as AgentGroup);

    expect(getMessagingGroupMock).toHaveBeenCalledWith('mg-1');
    expect(seen).toEqual([{ messagingGroup: group, agentGroupId: 'ag-1' }]);
    expect(resolved.env).toEqual({
      SHARED: 'agent-1',
      CHANNEL_ONLY: 'c',
      AGENT_SHARED: 'agent-2',
      AGENT_GROUP: 'ag-1',
    });
    expect(resolved.mcpServers).toEqual({ shared: { command: 'agent-1', args: [] } });
    expect(resolved.userVisibleTools).toEqual(['channel_tool', 'agent_1_tool', 'agent_2_tool']);
  });
});
