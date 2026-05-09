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
- `src/channels/index.ts` contains `import './thenvoi.js';`
- `container/agent-runner/src/mcp-tools/thenvoi.ts` exists
- `container/agent-runner/src/mcp-tools/index.ts` contains `import './thenvoi.js';`
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `package.json`
- `@thenvoi/sdk` and `@thenvoi/rest-client` are listed in `container/agent-runner/package.json`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the Band integration branch

Fetch the branch that carries the v2 Band.ai integration:

```bash
git fetch origin migrate/band-v2-foundation
```

If this integration has landed under a different branch name, use that branch in the `git show` commands below.

### 2. Copy host-side Band files

```bash
git show origin/migrate/band-v2-foundation:src/channels/thenvoi.ts > src/channels/thenvoi.ts
git show origin/migrate/band-v2-foundation:src/modules/thenvoi-config.ts > src/modules/thenvoi-config.ts
git show origin/migrate/band-v2-foundation:src/db/migrations/014-route-foundation-state.ts > src/db/migrations/014-route-foundation-state.ts
git show origin/migrate/band-v2-foundation:src/db/inbound-delivery-ledger.ts > src/db/inbound-delivery-ledger.ts
git show origin/migrate/band-v2-foundation:src/db/module-state.ts > src/db/module-state.ts
git show origin/migrate/band-v2-foundation:src/db/outbound-delivery-markers.ts > src/db/outbound-delivery-markers.ts
```

Also copy any related test files if this is a development checkout:

```bash
git show origin/migrate/band-v2-foundation:src/channels/thenvoi.test.ts > src/channels/thenvoi.test.ts
```

### 3. Copy container Band tools

```bash
git show origin/migrate/band-v2-foundation:container/agent-runner/src/mcp-tools/thenvoi.ts > container/agent-runner/src/mcp-tools/thenvoi.ts
git show origin/migrate/band-v2-foundation:container/agent-runner/src/mcp-tools/thenvoi.instructions.md > container/agent-runner/src/mcp-tools/thenvoi.instructions.md
git show origin/migrate/band-v2-foundation:container/agent-runner/src/mcp-tools/thenvoi.test.ts > container/agent-runner/src/mcp-tools/thenvoi.test.ts
```

### 4. Register imports and migrations

Append these imports if they are not already present:

```typescript
// src/channels/index.ts
import './thenvoi.js';

// container/agent-runner/src/mcp-tools/index.ts
import './thenvoi.js';
```

In `src/db/migrations/index.ts`, import `migration014` and include it in the `migrations` array after the existing core migrations:

```typescript
import { migration014 } from './014-route-foundation-state.js';
```

In `src/db/index.ts`, export the inbound delivery ledger, module state, and outbound delivery marker helpers copied above.

### 5. Install packages

```bash
pnpm add @thenvoi/sdk@0.1.6 @thenvoi/rest-client@0.0.113
cd container/agent-runner && bun add @thenvoi/sdk@0.1.6 @thenvoi/rest-client@0.0.113
```

### 6. Configure environment

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

# Contact-event strategy: disabled | callback | hub_room.
# See "Contact strategies" below.
THENVOI_CONTACT_STRATEGY=disabled
```

For normal hosted Band.ai, leave `THENVOI_BASE_URL` unset or set it to `https://app.thenvoi.com`. Direct `THENVOI_API_KEY` injection into agent containers is only for local HTTP validation or explicit `THENVOI_INJECT_API_KEY=true`; hosted HTTPS sessions should use OneCLI secret injection.

#### Memory knobs

- `THENVOI_MEMORY_TOOLS` — exposes `mcp__nanoclaw__band_list_memories`, `band_store_memory`, `band_supersede_memory`, etc. to the agent. The other two memory knobs are no-ops without this enabled.
- `THENVOI_MEMORY_LOAD_ON_START` — at container startup, fetch each room participant's stored memories via the SDK (`thenvoi_list_memories`, scope=`subject`, top 10 per participant) and append them to the system prompt as `## Existing Memories About Room Participants`. Also injects a synthetic `[System]` message into the room when a new participant joins mid-session (`participant_added`), with up to 10 of that participant's memories. Failure is non-fatal: the agent still starts.
- `THENVOI_MEMORY_CONSOLIDATION` — after the poll loop exits (typically on SIGTERM from `docker stop` when the host kills the container), run a one-shot consolidation pass against the same provider session. The pass is forbidden from sending chat messages or `<message to="…">` blocks; it only calls memory tools and emits thought events. Output is drained, not delivered. The host's `killContainer()` uses a 30-minute SIGTERM grace window so the pass has time to finish before SIGKILL.

#### Contact strategies

`THENVOI_CONTACT_STRATEGY` controls what the host does with `contact_request_received`, `contact_request_updated`, `contact_added`, and `contact_removed` events emitted by Band:

- `disabled` (default) — events are dropped silently. The agent never sees contacts; outbound contact tools still work.
- `callback` — `contact_request_received` events are auto-approved via `agentApiContacts.respondToAgentContactRequest({ action: 'approve', request_id })`. Other contact events are ignored.
- `hub_room` — lazily provision a per-agent "Contact Hub" Band chat room, add `THENVOI_OWNER_ID` (or the value resolved from `GET /agent/me`) as a member, persist its room id in `data/v2.db` module state, and forward every contact event into the hub as a synthetic message. The owner replies in the hub.

Sync the environment file if this instance uses `data/env/env`:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 7. Build and test

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
- Contact-event handling: drop, auto-approve callback, or hub-room forwarding (`THENVOI_CONTACT_STRATEGY`)
- Hosted Band sessions avoid direct API-key env injection; local HTTP validation can opt in

## Troubleshooting

If messages appear in Band but the agent does not answer, check that the room is wired, not only discovered:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE channel_type='thenvoi'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

If tools are missing inside the container, verify that the session is Band-backed and that `container/agent-runner/src/mcp-tools/index.ts` imports `./thenvoi.js`.

If memory tools return disabled/unavailable, leave them disabled for that run. Do not claim cross-room memory was stored unless the `band_store_memory` call succeeds.
