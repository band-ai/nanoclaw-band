---
name: add-band
description: Add Band.ai channel integration. Uses the Thenvoi SDK identifiers internally while presenting Band.ai to users.
---

# Add Band.ai Channel

Adds Band.ai chat support to NanoClaw. Thenvoi remains the load-bearing internal identifier for package names, environment variables, channel type, and platform IDs, so the channel is registered as `thenvoi` and uses `THENVOI_*` settings.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/thenvoi.ts` exists
- `src/channels/channel-container-registry.ts` exists
- `src/channels/index.ts` contains `import './thenvoi.js';`
- `src/db/inbound-delivery-ledger.ts`, `src/db/module-state.ts`, and `src/db/outbound-delivery-markers.ts` exist
- `container/agent-runner/src/mcp-tools/thenvoi.ts` exists
- `container/agent-runner/src/mcp-tools/index.ts` contains `import './thenvoi.js';`
- `container/agent-runner/src/band-memory-load.ts` and `container/agent-runner/src/band-memory-consolidate.ts` exist
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `package.json`
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `container/agent-runner/package.json`
- `docker-compose.yml`, `Dockerfile.host`, `container/Dockerfile`, and `.env.compose.template` exist
- `container/agent-runner/src/providers/claude.ts` contains `CLAUDE_CODE_EXECUTABLE`
- `container/agent-runner/src/providers/mock.ts` wraps default replies in `<message to="...">` when a prompt has a source destination
- `src/container-runner.ts` calls `rewriteOneCliProxyArgs(args)` after OneCLI applies container config

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the Band integration branch

Fetch the branch that carries the v2 Band.ai integration:

```bash
git fetch origin migrate/band-v2-foundation
```

If this integration has landed under a different branch name, use that branch in the `git show` commands below.

### 2. Copy the Band runtime file set

Band touches channel ingestion, route idempotency, outbound delivery markers, container env projection, and the agent-runner MCP/tools loop. Copy the whole tested file set from the integration branch instead of only the obvious `thenvoi.ts` files; a partial copy can compile but fail at runtime, or fail typecheck because shared route contracts drifted.

```bash
git checkout origin/migrate/band-v2-foundation -- \
  .dockerignore \
  .env.compose.template \
  .env.example \
  .gitignore \
  Dockerfile.host \
  docker-compose.yml \
  docs/docker-compose-deployment.md \
  container/Dockerfile \
  container/agent-runner/bun.lock \
  container/agent-runner/package.json \
  container/agent-runner/src/band-memory-consolidate.test.ts \
  container/agent-runner/src/band-memory-consolidate.ts \
  container/agent-runner/src/band-memory-load.test.ts \
  container/agent-runner/src/band-memory-load.ts \
  container/agent-runner/src/index.ts \
  container/agent-runner/src/integration.test.ts \
  container/agent-runner/src/mcp-tools/index.ts \
  container/agent-runner/src/mcp-tools/server.ts \
  container/agent-runner/src/mcp-tools/thenvoi.instructions.md \
  container/agent-runner/src/mcp-tools/thenvoi.test.ts \
  container/agent-runner/src/mcp-tools/thenvoi.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/providers/claude.ts \
  container/agent-runner/src/providers/mock.ts \
  container/agent-runner/src/providers/types.ts \
  package.json \
  pnpm-lock.yaml \
  src/channels/adapter.ts \
  src/channels/channel-container-registry.test.ts \
  src/channels/channel-container-registry.ts \
  src/channels/cli.ts \
  src/channels/index.ts \
  src/channels/thenvoi.test.ts \
  src/channels/thenvoi.ts \
  src/circuit-breaker.test.ts \
  src/circuit-breaker.ts \
  src/container-runner.test.ts \
  src/container-runner.ts \
  src/container-runtime.test.ts \
  src/container-runtime.ts \
  src/db/db-v2.test.ts \
  src/db/inbound-delivery-ledger.ts \
  src/db/index.ts \
  src/db/migrations/014-route-foundation-state.ts \
  src/db/migrations/index.ts \
  src/db/module-state.ts \
  src/db/outbound-delivery-markers.ts \
  src/db/schema.ts \
  src/db/session-db.test.ts \
  src/db/session-db.ts \
  src/db/sessions.ts \
  src/host-core.test.ts \
  src/index.ts \
  src/modules/agent-to-agent/agent-route.test.ts \
  src/modules/thenvoi-config.ts \
  src/providers/claude.ts \
  src/providers/index.ts \
  src/router.ts
```

This command also brings in the self-registration imports, migration registration, and db barrel exports. If the checkout has local changes in any listed file, review `git diff` first and merge deliberately instead of blindly overwriting.

### 3. Install packages from the copied lockfiles

```bash
pnpm install --frozen-lockfile
cd container/agent-runner && bun install --frozen-lockfile
```

### 4. Configure environment

Add the agent credentials to `.env`:

```bash
THENVOI_AGENT_ID=your-agent-id
THENVOI_API_KEY=your-agent-api-key
# Optional. Defaults to https://app.thenvoi.com when unset.
THENVOI_BASE_URL=https://app.thenvoi.com

# Optional. UUID of the Band user who owns this agent. Used by the contact
# hub-room strategy (added as the room owner) and other paths that need to
# address the owner directly. Falls back to GET /agent/me when unset.
THENVOI_OWNER_ID=

# Memory feature flags. See "Memory knobs" below.
THENVOI_MEMORY_TOOLS=false
THENVOI_MEMORY_LOAD_ON_START=false
THENVOI_MEMORY_CONSOLIDATION=false

# Contact-event strategy: disabled | hub_room.
# See "Contact strategies" below.
THENVOI_CONTACT_STRATEGY=disabled
# Optional. Agent group that should handle Contact Hub synthetic messages.
# If unset and exactly one agent group exists, NanoClaw uses that group.
THENVOI_CONTACT_AGENT_GROUP_ID=
```

For normal hosted Band.ai, leave `THENVOI_BASE_URL` unset or set it to `https://app.thenvoi.com`. Direct `THENVOI_API_KEY` injection into agent containers is only for local HTTP validation or explicit `THENVOI_INJECT_API_KEY=true`; hosted HTTPS sessions should use OneCLI secret injection.

#### Memory knobs

- `THENVOI_MEMORY_TOOLS` — exposes `mcp__nanoclaw__band_list_memories`, `band_store_memory`, `band_supersede_memory`, etc. to the agent. The other two memory knobs are no-ops without this enabled.
- `THENVOI_MEMORY_LOAD_ON_START` — at container startup, fetch each room participant's stored memories via the SDK (`thenvoi_list_memories`, scope=`subject`, top 10 per participant) and append them to the system prompt as `## Existing Memories About Room Participants`. Also injects a synthetic `[System]` message into the room when a new participant joins mid-session (`participant_added`), with up to 10 of that participant's memories. Failure is non-fatal: the agent still starts.
- `THENVOI_MEMORY_CONSOLIDATION` — after the poll loop exits (typically on SIGTERM from `docker stop` when the host kills the container), run a one-shot consolidation pass against the same provider session. The pass is forbidden from sending chat messages or `<message to="…">` blocks; only memory tools are available at runtime. Output is drained, not delivered. No-op unless `THENVOI_MEMORY_TOOLS` is also enabled.

#### Contact strategies

`THENVOI_CONTACT_STRATEGY` controls what the host does with `contact_request_received`, `contact_request_updated`, `contact_added`, and `contact_removed` events emitted by Band:

- `disabled` (default) — events are dropped silently. The agent never sees contacts; outbound contact tools still work.
- `hub_room` — lazily provision a per-agent "Contact Hub" Band chat room, add `THENVOI_OWNER_ID` (or the value resolved from `GET /agent/me`) as a member, persist its room id in `data/v2.db` module state, wire it to `THENVOI_CONTACT_AGENT_GROUP_ID` (or the only agent group when exactly one exists), and forward every contact event into the hub as a synthetic message. The owner replies in the hub.

Sync the environment file if this instance uses `data/env/env`:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 5. Build and test

```bash
pnpm install
pnpm run build
pnpm test -- src/channels/thenvoi.test.ts
cd container/agent-runner && bun test src/mcp-tools/thenvoi.test.ts
```

## Wire Band rooms

The Band adapter discovers rooms into `messaging_groups`, but discovery alone does not wire a room to an agent. Run `/manage-channels` and wire the desired Band room using:

- **type**: `thenvoi`
- **platform ID format**: `thenvoi:<room-id>`
- **session mode**: `shared` for room-local conversations, or `agent-shared` only when intentionally merging multiple channel surfaces into one agent session

For v1-style Band parity, use an engagement policy that responds in the selected room rather than silently accumulating ignored chatter.

## Channel Info

- **type**: `thenvoi`
- **user-facing name**: Band.ai
- **terminology**: Band has rooms/chats. The main control room is the owner-visible direct room and blocks room/participant mutation tools.
- **platform-id-format**: `thenvoi:<roomId>`
- **supports-threads**: no
- **typical-use**: Direct Band room or shared collaboration room with SDK-backed platform tools
- **default-isolation**: Same agent group for your own Band rooms. Separate agent groups for rooms with different people, projects, or data boundaries.

## Features

- Native Band message ingestion through the Thenvoi SDK
- SDK-backed Claude-visible tools exposed as `band_*`
- Fallback outbound delivery for ordinary NanoClaw `messages_out` chat rows
- Main control room detection and container env propagation
- Main-room participant/room mutation guardrails
- Memory tools gated by `THENVOI_MEMORY_TOOLS` and disabled for the run if the Band memory API is unavailable
- Optional participant-memory pre-load at startup (`THENVOI_MEMORY_LOAD_ON_START`)
- Optional end-of-session memory consolidation pass (`THENVOI_MEMORY_CONSOLIDATION`)
- Contact-event handling: drop or hub-room forwarding (`THENVOI_CONTACT_STRATEGY`)
- Hosted Band sessions avoid direct API-key env injection; local HTTP validation can opt in

## Troubleshooting

If messages appear in Band but the agent does not answer, check that the room is wired, not only discovered:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE channel_type='thenvoi'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

If tools are missing inside the container, verify that the session is Band-backed and that `container/agent-runner/src/mcp-tools/index.ts` imports `./thenvoi.js`.

If memory tools return disabled/unavailable, leave them disabled for that run. Do not claim cross-room memory was stored unless the `band_store_memory` call succeeds.
