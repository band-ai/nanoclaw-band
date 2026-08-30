# Channel container-config seam: fork vs upstream

**Status:** open divergence, benign at runtime, unresolved by design.
**Introduced:** fork commit `ebf911f0` (re-root onto `nanocoai/nanoclaw`).
**Surfaced:** upstream merge `3d842308` (`nanocoai/nanoclaw@294ef2ae`), which brought upstream's
independently-grown equivalent into the tree alongside the fork's.

The tree now carries **two** seams for "let a channel contribute to the agent container",
and **both export a function named `getChannelContainerConfig`**. Only the fork's is wired to
production. This document specifies both contracts, why they differ, and what consolidation costs.

## The collision

|  | Upstream | Fork |
|---|---|---|
| Module | `src/channels/channel-registry.ts:259` | `src/channels/channel-container-registry.ts:24` |
| Export | `getChannelContainerConfig(name)` | `getChannelContainerConfig(channelType)` |
| Returns | `ChannelRegistration['containerConfig']` — static data | `ChannelContainerConfigFn \| undefined` — a function |
| Declared in | `src/channels/adapter.ts:348` | `src/channels/channel-container-registry.ts:11` |
| Registered via | `registerChannelAdapter(name, { containerConfig })` | `registerChannelContainerConfig(channelType, fn)` |
| Production callers | **none** | `src/container-runner.ts:31, 536` |
| Test-only callers | `src/channels/channel-registry.test.ts:87, 98` | `src/channels/channel-container-registry.test.ts:4, 47` |

The name clash is currently harmless only because no module imports both. Any file that needs
both seams cannot `import { getChannelContainerConfig }` twice without aliasing.

## Upstream contract

Static declaration hung off the registry entry (`src/channels/adapter.ts:338-352`):

```ts
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  defaults?: ChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
```

Properties:

- **Static.** Resolved from the registration object; no call, no context, no `await`.
- **Resolvable without instantiating the adapter** — the same rationale that governs
  `defaults`: offline paths (`setup/register.ts`, `scripts/init-first-agent.ts`, `ncl` on a host
  where the factory returned `null` for missing creds) can read it.
- **Capability: mounts + env only.**
- **Dead in production.** Nothing calls `getChannelContainerConfig` from
  `src/channels/channel-registry.ts` outside its own test. Upstream built the seam and has not
  yet consumed it.

## Fork contract

Two registries — channel-scoped and agent-scoped — both returning the richer
`ProviderContainerContribution` (`src/channels/channel-container-registry.ts`):

```ts
export interface ChannelContainerContext {
  session: Session;
  messagingGroup: MessagingGroup | null;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type ChannelContainerConfigFn = (
  ctx: ChannelContainerContext,
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;

export interface AgentContainerContext {
  session: Session;
  agentGroupId: string;
  hostEnv: NodeJS.ProcessEnv;
}

export type AgentContainerConfigFn = (
  ctx: AgentContainerContext,
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;
```

The contribution type (`src/providers/provider-container-registry.ts`) is shared with the
provider seam:

```ts
export interface ProviderContainerContribution {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerContribution>;
  userVisibleTools?: string[];
}
```

### Agent-scoped registry

`registerAgentContainerConfig(fn)` appends to an **array**, not a keyed map, and applies to
**every session of an agent group regardless of that session's channel**. This exists so a
channel can grant the agent cross-channel control tools — Band peer/room management reachable
from a Telegram session. The producer decides applicability per agent group and returns `{}`
otherwise.

Note the asymmetry: the channel registry throws on duplicate registration
(`src/channels/channel-container-registry.ts:18-20`); the agent registry accepts unbounded
registrants.

### Fan-in and precedence

`resolveContainerContribution` (`src/container-runner.ts:516-553`) merges three tiers:

```
provider  →  channel  →  agent-scoped
```

`mergeContainerContributions` (`src/container-runner.ts:555-564`) merges field-wise:

| Field | Strategy | Collision winner |
|---|---|---|
| `mounts` | `flatMap` — concatenate | n/a, all kept |
| `env` | `Object.assign` | later tier |
| `mcpServers` | `Object.assign` | later tier |
| `userVisibleTools` | `flatMap` — concatenate | n/a, all kept |

So on an `env` or `mcpServers` name clash: agent-scoped beats channel, channel beats provider.

### Downstream consumption

Two contribution fields have no upstream equivalent and are consumed at spawn time
(`src/container-runner.ts:789-798`):

- `mcpServers` → `NANOCLAW_EXTRA_MCP_SERVERS` (JSON) → read at
  `container/agent-runner/src/index.ts:118` and passed as `extraMcpJson` to `buildMcpServers()`
  (`container/agent-runner/src/mcp-servers.ts`), which folds `mcpEnv` under each extra server and
  ignores malformed JSON without throwing
- `userVisibleTools` → `NANOCLAW_USER_VISIBLE_TOOLS` (JSON) → read at
  `container/agent-runner/src/providers/claude.ts:30`, which seeds the tool registry in
  `container/agent-runner/src/mcp-tools/server.ts` via `markUserVisibleTool`

Both stay absent when empty, so the container sees no extra servers rather than an empty map.

`userVisibleTools` is load-bearing beyond configuration: it feeds the
`user_visible_tool` provider event (`container/agent-runner/src/providers/types.ts`) which
drives the poll-loop's double-delivery suppression (`userVisibleToolUsed`,
`container/agent-runner/src/poll-loop.ts`). Without it, an agent that already sent a message via
`mcp__nanoclaw__band_send_message` would have its text re-delivered.

## Capability gap

| Requirement | Upstream | Fork |
|---|---|---|
| Extra mounts | yes | yes |
| Extra env | yes | yes |
| Contribute MCP servers | **no** | yes |
| Declare user-visible tools | **no** | yes |
| Per-session context | **no** (static) | yes |
| Per-messaging-group context | **no** | yes |
| Async resolution | **no** | yes |
| Agent-scoped / cross-channel | **no** | yes |
| Resolvable without instantiating adapter | yes | **no** (needs a live session) |

The last row is the one capability upstream has and the fork does not, and it is the reason
upstream's seam is static: offline creation paths must read it before any adapter exists.
The two seams are therefore **not** strict subset/superset — they answer different questions.

## Why the fork could not use upstream's field

Ordered by how hard each blocks adoption:

1. **`mcpServers` and `userVisibleTools` are unrepresentable.** Upstream's `containerConfig` is
   `{ mounts, env }`. Band contributes a `thenvoi-mcp` server and the user-visible tool name
   `mcp__nanoclaw__band_send_message`. No encoding of these into `mounts`/`env` is honest.
2. **Contribution depends on the session.** Upstream's shape is resolved once per registration;
   the fork's is resolved per spawn with `session` and `messagingGroup` in hand.
3. **Agent-scoped contributions have no upstream analogue.** Upstream's map is keyed by channel
   name, so it cannot express "applies to every session of this agent group whatever the channel".
4. **`/add-band` hard-depends on the richer contract.** Its Phase 0 preflight
   (`.claude/skills/add-band/SKILL.md:85`) aborts the install when
   `src/providers/provider-container-registry.ts` lacks `userVisibleTools`, alongside checks for
   `supportsDeliveryAck`, `needsGracefulStop`, `registerChannelMigrations`,
   `container/agent-runner/src/lifecycle.ts` and `container/agent-runner/src/mcp-servers.ts`.
   The skill refuses to copy Band onto a base without these seams rather than fail the build
   with "undefined export".

## Consolidation options

### A. Rename the fork export, keep both seams — recommended first step

Rename `getChannelContainerConfig` → `getChannelContainerContribution` (and
`registerChannelContainerConfig` → `registerChannelContainerContribution`) in
`src/channels/channel-container-registry.ts`, its test, and the single import at
`src/container-runner.ts:31`.

- Cost: three files, mechanical, zero behavior change.
- Removes the name collision and makes each seam's role legible at the callsite.
- Does not reduce the fork's diff surface against upstream.
- Leaves upstream's field dead in-tree, which is upstream's business, not drift.

### B. Propose upstream widen `containerConfig` to a function

Upstream PR: allow `ChannelRegistration.containerConfig` to be either the current static object
or a `(ctx) => Promise<ChannelContainerContribution>`, with the contribution type extended to
carry `mcpServers` and `userVisibleTools`. Keep the static form for offline paths.

- Upside: eliminates the divergence at the root; the fork deletes
  `src/channels/channel-container-registry.ts` and registers through `registerChannelAdapter`.
- Cost: upstream review cycle; upstream currently has no consumer, so the motivating use case is
  entirely ours and must be argued from the Band adapter.
- Blocker: the agent-scoped registry still has no home. Either upstream accepts a second
  registration surface, or the fork keeps a reduced
  `src/channels/channel-container-registry.ts` for that tier alone.

### C. Bridge — fork seam falls back to upstream's static field

Have the fork's `getChannelContainerConfig` synthesize a `ChannelContainerConfigFn` from
upstream's `containerConfig` when no function is registered for that channel.

- Upside: one lookup path; upstream's field stops being dead; channels may declare either shape.
- Cost: two ways to say the same thing, with precedence rules to document and test. Adds
  surface rather than removing it.
- Not recommended while upstream's field has no registrants: the bridge would be dead code
  serving a dead field.

## Recommendation

Take **A** now — it is three files and retires the only concrete hazard, the duplicate export
name. Open **B** upstream and let the fork's `src/channels/channel-container-registry.ts` remain
until upstream accepts a widened contract. Decline **C**.

Do not delete upstream's `ChannelRegistration.containerConfig`: it is upstream API surface with a
distinct guarantee (adapter-free resolution) that the fork's seam does not provide, and removing
it would create a real conflict on every future sync.

## Invariants to preserve under any consolidation

- `userVisibleTools` must keep reaching `NANOCLAW_USER_VISIBLE_TOOLS`, or poll-loop
  double-delivery suppression silently dies — it fails as a behavior regression, not a build error.
- Merge order must stay provider → channel → agent-scoped.
  `src/container-runner.test.ts:502` (`describe('mergeContainerContributions')`) pins the
  concatenate-vs-override split per field; `:535` pins `stopGraceForReason`, `:547` pins
  `rewriteOneCliProxyEnv`.
- The channel registry's duplicate-registration throw is load-bearing for idempotent
  `/add-<channel>` re-runs.
- `/add-band`'s Phase 0 preflight greps for literal symbol names. Renaming
  `userVisibleTools` in `src/providers/provider-container-registry.ts` breaks the installer even
  if the code still compiles.
